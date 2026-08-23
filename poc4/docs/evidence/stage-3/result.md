# EnsoAI Stage 3 Writable Workbench Result

## Source Commit

- 日期：`2026-08-24`
- 分支：`poc4/ensoai-stage-3-writable-workbench`
- 验证树（完整矩阵）：`b111d5d9941a2a697157e7f731b8b794d3f67593`（`b111d5d` `fix(poc4): focus cancel on leave unsaved dialog`）
- 本报告是该 SHA 之后的文档提交，不改应用源码
- 工作目录：`poc4/frontend`；包管理器仅 pnpm
- EnsoAI 来源仍为 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；阶段 3 未再复制新的 EnsoAI 大组件
- 本报告所有退出码、测试数、构建体积、扫描结果与大文件实测均在 `b111d5d` 上新鲜执行。离开工作台对话框默认焦点为 Cancel 的产品代码包含在该 SHA 内，Chrome/Edge 功能矩阵已在同一 SHA 复跑。

阶段 3 实现提交（`e75a298..b111d5d`）：

| SHA | 说明 |
|---|---|
| `e75a298` | 阶段 3 计划 |
| `d1facca` | 文件写契约与 revision / basename 解析 |
| `3ae216a` | 可重置 MSW 工作区与写场景 |
| `f1ad484` / `87481c1` | 可写缓冲区与 dispose / remap |
| `0c36547` / `da50209` | 串行 mutation 与 revision 缓存 |
| `1ffc876` / `ff68937` / `84ce73c` | 显式保存与纯文本隔离 |
| `a0609dd` / `4118047` | dirty 导航守卫 |
| `6814cb2` | 创建文件与目录 |
| `8dc44af` | 重命名与删除 |
| `659c464` | 组装可写工作台与 Run precondition |
| `18726e5` | Stage 3 E2E、12 张 PNG、真实大写入 |
| `a6b1190` | large-files E2E 改为可写载荷证明 |
| `c2c6ef5` | large-files Monaco 可写按长度断言 |
| `2ea9e80` | 首次证据报告（认证 `c2c6ef5`，已被本报告取代） |
| `b111d5d` | 离开/logout 确认框初始焦点改为 Cancel |

## Scope Boundary

阶段 3 仍是纯浏览器前端。证据只证明浏览器面对 mock `200/202/401/403/409/413/415/5xx`、文件 `tree/meta/content/download` 以及 mock 写 API 时的状态机。用语一律为 **mock contract verified**。不得从 MSW 得出真实后端授权、PVC 原子写、symlink escape、项目所有权、真实锁或 Kubernetes 集成已验证。

包含：`READY` 项目可写工作台、项目内正斜杠相对路径、根目录 revision 种子、Monaco / `PLAIN_TEXT` 显式保存与 `Ctrl+S`、保存中继续编辑保持 dirty、文件/目录创建、同目录重命名、确认删除、dirty 后代阻断、导航/logout 守卫、`BLOCKED` 零正文与 PUT 415、logout / 当前会话 401 清空、生产构建排除 mock、Chromium / Chrome / Edge 工作流与真实 `20 MiB + 1` Markdown 写入。

明确排除：真实 Spring Boot / JWT 签名 / MySQL、真实 PVC / 工作区 Pod / 文件代理、拖拽上传 / Git / 搜索 / 跨目录移动、自动保存、Run / 日志 / 真实 PTY、refresh token、工作台状态持久化。`canRequestRun` 恒为 false。

## Automated Verification

工作目录：`poc4/frontend`。下列命令均在 `b111d5d` 对应工作树执行。`rg` 不在 PATH；生产排除扫描见后文。浏览器测试后 `git diff --check` 无空白错误。channels 会改写已提交 PNG；Stage 0 / Stage 2 与本次重拍的 Stage 3 PNG 均已 `git checkout` 还原，未纳入本报告提交。第 509 条单测是离开对话框聚焦 Cancel（`UnsavedChangesDialog.test.tsx`）。

| 命令 | 退出码 | 观察结果 |
|---|---:|---|
| `pnpm test:boundary` | 0 | node:test **16 pass / 0 fail**（`duration_ms 125.8978`；命令墙钟 841 ms）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | `tsc -b --pretty false` 无诊断输出（4866 ms） |
| `pnpm test` | 0 | Vitest 3.2.7：Test Files **34 passed (34)**；Tests **509 passed (509)**；Duration 39.24s（墙钟 40945 ms）。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示（Spike），不计入失败 |
| `pnpm build`（矩阵首次） | 0 | 内含 typecheck；Vite 7.3.6 production；`3746 modules transformed`；`built in 45.00s`（墙钟 51306 ms）。入口 `index-DtVFVaEX.js` 387.90 kB / gzip 123.08 kB；工作台 `WorkbenchPage-CPiVnFWW.js` 3,964.55 kB / gzip 1,031.42 kB |
| `pnpm build:mock` | 0 | Vite mock；`3763 modules transformed`；`built in 48.78s`（墙钟 56447 ms）。含 `stage0.html`、MSW worker、Monaco workers。存在 `>500 kB` chunk 提示，构建仍成功 |
| `pnpm test:e2e` | 0 | Playwright Chromium：Running 50 tests using 4 workers；**38 passed / 12 skipped**（1.8m，墙钟 107750 ms）。跳过的是 Spike / Stage 1 / Stage 2 / Stage 3 截图（仅 chrome/edge） |
| `pnpm test:e2e:channels` | 0 | Playwright chrome + edge：Running 100 tests using 8 workers；**100 passed**（3.3m，墙钟 196560 ms）。含 `back and logout guards support Cancel and Discard` |
| `pnpm test:e2e:large-files` | 0 | Playwright `chromium-large-files`：**2 passed**（1.2m，墙钟 72355 ms） |
| `pnpm test:e2e:large-writes` | 0 | Playwright `chromium-large-writes`：**1 passed**（1.2m，墙钟 72913 ms，180s ceiling） |
| `pnpm build`（E2E 后生产重建） | 0 | mock/E2E 覆盖 `dist/` 后再构建；`3746 modules transformed`；`built in 47.12s`（墙钟 53523 ms）；产物哈希与矩阵首次生产构建一致（`index-DtVFVaEX.js` / `WorkbenchPage-CPiVnFWW.js`） |
| `git -C ../.. diff --check` | 0 | 干净 |
| `git -C ../.. status --short` | 0 | 矩阵结束时仅 PNG recapture；已还原。本报告提交前工作树仅本文件变更 |

本矩阵不再依赖 `a6b1190` / `c2c6ef5` 的旧命令输出。先前 `a6b1190` 上 large-files 第 1 行断言失败已由 `c2c6ef5` 改为长度断言，并在 `b111d5d` 上复跑通过。

## Contract And Revision Evidence

本项为 **mock contract verified**。

1. `parseProjectRelativePath` 只接受正斜杠相对路径；拒绝 leading `/`、`\`、Windows 盘符、UNC、NUL、空段、`.`、`..`。根目录只用 `''`。`parseWorkspaceRevision` 只要求非空且 ≤ 256 个 UTF-16 code units，不解释格式。basename 构造另由 `entryNamePolicy` 拒绝绝对路径、反斜杠、`.`、`..`、NUL。
2. 写 API 只接受 branded 路径。HTTP 形态：
   - `PUT /api/v1/projects/{encodeURIComponent(projectId)}/files/content?path={relativeFile}`
   - `POST /api/v1/projects/{encodeURIComponent(projectId)}/entries`
   - `POST /api/v1/projects/{encodeURIComponent(projectId)}/entries/rename`
   - `DELETE /api/v1/projects/{encodeURIComponent(projectId)}/entries?path={relative}`
3. 根 `GET .../files/tree?path=` 种子 opaque revision（MSW 为 `mock-rev-0001`）。客户端从不生成 revision。成功写响应推进到 `mock-rev-0002` 等；失败分支不递增。
4. 运行时解析器对畸形 revision / path / entry / metadata 抛出单一 `Invalid file response`，不渲染部分树。
5. Chromium E2E `saves with Ctrl+S using a relative PUT, Bearer token and expected revision` 观察到的请求（密钥已脱敏）：

```http
PUT /api/v1/projects/prj-alice-notebook/files/content?path=pom.xml HTTP/1.1
Host: 127.0.0.1:4173
Authorization: Bearer <redacted>
Accept: application/json
Content-Type: application/json
```

```json
{
  "content": "<pom.xml snapshot containing STAGE3SAVE>",
  "expectedWorkspaceRevision": "mock-rev-0001"
}
```

成功响应 `200`，`workspaceRevision` 为新的非空 opaque 令牌且不等于请求中的 expected 值；标签去掉 `*`，出现 `role="status"` `Saved`。JWT 只在 `Authorization` 头，不进入 URL 或 JSON body。

6. 失败不推进 revision、不清 dirty：
   - `409 PROJECT_LOCKED`（`write-scenario=locked`）→ 文案 “Project is locked”，缓冲仍含 `STAGE3KEEP`
   - `409 WORKSPACE_REVISION_CONFLICT` → “Workspace revision conflict”，缓冲保留
   - `413`（页内 fetch 包装）→ “file is too large”
   - 网络失败 → “network request failed”
   - `BLOCKED` 二进制越过 UI 的 PUT → `415 BINARY_FILE`，content GET 计数仍为 0
7. delayed-save：`write-scenario=delayed` 后先保存快照 `STAGE3FIRST`，保存未返回前再写入 `STAGE3LATER`。PUT body 含 FIRST、不含 LATER；响应后标签仍带 `*`，模型含 LATER。
8. mutation 顺序（单测）：cancel 当前项目 tree/meta/content refetch → 写请求 → 成功后更新 content/metadata → **最后**写 revision。失败体不写入缓存。Refresh 只失效 tree keys，不替换 dirty 缓冲。
9. 关闭标签：先切走再 dispose 该 path 的 model / buffer。项目切换：`cancelQueries` → `disposeProject` + `disposeProjectModels` → `session.reset()` → `removeQueries` → `activateProject`。logout / 当前会话 401：关连接 → dispose 工作台资源 → reset session → `queryClient.clear()` → 清 auth。Alice 迟到的 401 不清除 Bob。

前端路径与 revision 比较不能替代后端事务、锁或 symlink 防护。这些在真实后端上仍未验证。

## CRUD And Navigation Evidence

本项为 **mock contract verified**。

1. 创建：根 `New file` → `notes.md` 只增加根 `tree` 计数，不请求 `src`/`docs`；在 `src` 下 `New folder` → `lib` 只增加 `src` tree；在 `demo` 下创建 `extra.java` 只增加该层。新文件打开为可写标签。
2. 重命名：打开的 `pom.xml` → `project.xml` 后旧 treeitem / tab / title 消失；目录 `src` → `source` 后打开的 `App.java` title 变为 `source/main/java/demo/App.java`，页面无旧 `src/main/java/demo/App.java` 字符串。单测用 segment-safe 边界，不把 `src/ab` 当成 `src/a` 的后代。
3. 删除：Cancel 后 `README.md` 树与标签不变；非空 `src` 确认后对话框内 `DIRECTORY_NOT_EMPTY`（“Directory is not empty”），树仍在；空目录 `tmp` 确认后消失。
4. dirty 后代：选中含 dirty 子文件的目录时 Rename / Delete 禁用，title 为 “Save or discard unsaved changes before renaming/deleting”；前缀兄弟 `src/ab` 不受 `src/a` dirty 影响。
5. 关闭 dirty 标签：Cancel 保留标签与缓冲；Discard 关闭且再打开为服务端版本；Save and close 先 PUT 再关，再打开含已保存文本且无 `*`。
6. Back / logout：Cancel 不改变 URL、认证、标签或模型；Discard and leave 才离开。离开/logout 确认框打开后初始焦点在 Cancel（`b111d5d`；单测 + Chromium/Chrome/Edge `back and logout guards`）。`beforeunload` 仅在存在 dirty 时注册。
7. 当前 token 401：`POST /api/v1/session/expire`（mock-only）+ Refresh 回到 `/login`，一条过期会话 alert，无 Unsaved 对话框。Alice/Bob 互不可见树、标签与 `ALICEONLY` 文本。
8. Run / Terminal 保持禁用。干净时 accessible description 含 `STAGE_4_UNAVAILABLE`；dirty 时 Run 为 `DIRTY_FILES`。强制点击不产生 `/runs`、log 或生产 terminal 请求。

真实文件系统语义、非空目录并发与 symlink 仍未验证。

## Browser And Visual Evidence

Chromium（`pnpm test:e2e`，退出 0）：

| 范围 | 结果 |
|---|---|
| Stage 3 功能 13 条 | 通过（dirty 切回、Ctrl+S、delayed save、失败保脏、close/back/logout 守卫、CRUD、refresh、blocked PUT 415、Alice/Bob + 401、零 `/runs`、键盘） |
| Stage 2 功能回归 | 通过（含可写 Monaco 打字、plain textarea 非 readonly、阻断零正文） |
| Stage 1 / Spike | 通过 |
| 截图 12 条（Spike 3 + Stage 1 3 + Stage 2 3 + Stage 3 3） | skipped |

Chrome + Edge（`pnpm test:e2e:channels`，退出 0）：

| Project | Passed | Failed | Notes |
|---|---:|---:|---|
| chrome | 50 | 0 | 含 Stage 3 功能 + 3 条 dirty/delete-dialog 截图 |
| edge | 50 | 0 | 同上 |

12 张视觉证据已在 `18726e5` 写入 `poc4/docs/evidence/stage-3/`（dirty 工作台与删除对话框，不含离开确认框）。`b111d5d` 的 channels 复跑通过了同一套几何/截图断言，并复拍了 2 张 Stage 3 1920 delete-dialog 以及 Stage 0/2 PNG；按约束全部还原，不提交。离开对话框安全焦点由功能 E2E 与单测覆盖，不依赖这些 PNG。PNG 字节不是 golden-file；断言的是 CSS 像素尺寸、无文档横向溢出、sidebar/editor 无内部重叠、Refresh / New file / Save / 活动标签 / Close / Delete / Cancel 可达、Monaco canvas 含非背景像素与 `STAGE3VISUAL`、`App.java` tab `title` 为完整相对路径且脏标 `*` 可见。

| 文件 | 像素 |
|---|---|
| `chrome-dirty-1280x720.png` / `chrome-delete-dialog-1280x720.png` | 1280×720 |
| `chrome-dirty-1440x900.png` / `chrome-delete-dialog-1440x900.png` | 1440×900 |
| `chrome-dirty-1920x1080.png` / `chrome-delete-dialog-1920x1080.png` | 1920×1080 |
| `edge-dirty-1280x720.png` / `edge-delete-dialog-1280x720.png` | 1280×720 |
| `edge-dirty-1440x900.png` / `edge-delete-dialog-1440x900.png` | 1440×900 |
| `edge-dirty-1920x1080.png` / `edge-delete-dialog-1920x1080.png` | 1920×1080 |

1280 px：Chrome/Edge dirty 工作台与删除对话框均通过无溢出、modal 在视口内与可达断言。

键盘：skip link → New file 对话框焦点包围与 Escape 回按钮 → 树打开文件 → Save → dirty 关闭框 → 删除确认 Cancel。离开/logout 确认框初始焦点为 Cancel。`role="alert"` 用于校验 / lock / conflict / 非空目录。`prefers-reduced-motion: reduce` 已模拟。树到达仍可能在 Tab 用尽后 `.focus()` 兜底（Task 10 minor）。

Playwright 1.62.1；Chromium `151.0.7922.34`。webServer 执行 `pnpm build:mock && pnpm preview`（4173）与 `pnpm dev:echo`（4174）。未连接真实 POC4 后端。

## Real-Size File Measurements

载荷未缩小。large-files 超时 120s；large-writes 超时 180s。均先 `POST /api/v1/session/large-files`（mock-only）。浏览器：Playwright Chromium 151.0.7922.34。

`pnpm test:e2e:large-files`（`b111d5d`，2 passed）：

| File | Renderer | 字符串长度 | Content bytes | Response `Content-Length` | Click → viewer-ready | Console errors | Page errors |
|---|---|---:|---:|---:|---:|---|---|
| `src/main/java/demo/NearLimit.java` | 可写 Monaco | 20,971,519（20 MiB − 1） | 20,971,519 | 20,971,619 | **638 ms** | none | none |
| `docs/large-notes.md` | 可写 textarea | 20,971,521（20 MiB + 1） | 20,971,521 | 20,971,603 | **4308 ms** | none | none |

可写证明：NearLimit 键入 `X` 后 `getValueLength() === 20 MiB` 且标签出现 `*`（插入点不必在第 1 行）。`large-notes.md` `readOnly === false`，键入后长度 +1 且 dirty。页面未崩溃。这只证明当前测试机器可运行，不构成生产 SLA。Stage 2 只读断言已删除，不再声称大文件只读。

`pnpm test:e2e:large-writes`（`b111d5d`，1 passed）：

| File | Renderer | 保存后 UTF-8 正文 | JSON 请求 UTF-8 | GET `Content-Length` | Click → ready | Save → response | Console | Page |
|---|---|---:|---:|---:|---:|---:|---|---|
| `docs/large-notes.md` | 可写 textarea | 20,971,538（20 MiB + 1 + `\nE2E_LARGE_WRITE\n`） | 20,971,601 | 20,971,603 | **3938 ms** | **1371 ms** | none | none |

切换到 `pom.xml` 再切回后后缀仍在；PUT `expectedWorkspaceRevision` 等于进入时的根 revision；保存后 dirty 清除；refetch 正文含后缀且 revision 已推进。20 MiB PUT 的 Playwright `postData()` 可能被 inspector 丢弃；请求 UTF-8 长度来自页内 `TextEncoder` 探针，不是传输层 `Content-Length`。

## Production Exclusion Evidence

矩阵中 `pnpm build:mock` 与 E2E 会覆盖 `dist/`，因此在 `b111d5d` 上于 large-writes 之后重新执行 `pnpm build`（production，非 mock）再扫描。`dist/stage0.html` 与 `dist/mockServiceWorker.js` 均不存在。产物 190 个文件。

扫描字符串（Stage 2 列表 **加上** Stage 3 scenario 与 mock 写夹具标记）：

```text
demo-pass
mockServiceWorker
/api/v1/session/expire
127.0.0.1:4174
stage0.html
window.electronAPI
node-pty
/api/v1/session/large-files
/api/v1/session/write-scenario
WRITE_SCENARIO
setWriteScenario
E2E_LARGE_WRITE
fileFixtures
```

UTF-8 解码后逐文件 `Contains`：`FORBIDDEN_MATCH_COUNT=0`（每条 needle 的 MATCH_FILES=0）。

入口 chunk `index-DtVFVaEX.js` **没有** `monaco-editor` / `@monaco-editor` 静态导入，也没有 Worker 文件名。其中出现的 `kind="monaco"` 来自打进入口的 `WorkspaceBufferRegistry` 判别字段，不是编辑器包。工作台 `WorkbenchPage` 仍由 `ProjectRoutePage` `lazy(() => import('./WorkbenchPage'))` 加载。五个 Monaco Worker 均存在于生产 `dist/assets/`。

关键产物（Vite 打印；Worker gzip 列为 Python `gzip.compress(level=9)`）：

| 路径 | raw | gzip |
|---|---:|---:|
| `dist/index.html` | 0.40 kB | 0.27 kB |
| `dist/assets/index-ClGF_-0n.css` | 35.35 kB | 6.73 kB |
| `dist/assets/index-DtVFVaEX.js`（入口，无静态 Monaco） | 387.90 kB | 123.08 kB |
| `dist/assets/WorkbenchPage-Ck3IbhyB.css` | 142.37 kB | 22.88 kB |
| `dist/assets/WorkbenchPage-CPiVnFWW.js`（工作台） | 3,964.55 kB | 1,031.42 kB |
| `dist/assets/editor.worker-C2_AfrSl.js` | 251,735 B | 75,278 B |
| `dist/assets/json.worker-C838mOW9.js` | 383,014 B | 112,906 B |
| `dist/assets/html.worker-eZJr__P7.js` | 693,120 B | 179,908 B |
| `dist/assets/css.worker-NZNbQL3P.js` | 1,030,315 B | 230,640 B |
| `dist/assets/ts.worker-BfwyojP3.js` | 7,010,073 B | 1,531,330 B |

Vite 打印 `Some chunks are larger than 500 kB after minification`。`chunkSizeWarningLimit` 未提高。

`main.tsx` 仅在 `import.meta.env.VITE_ENABLE_MOCK_API === 'true'` 时动态 `import('./mocks/browser')`。Vite `publicDir` 生产为 `public`，mock 为 `public-mock`。生产入口只有 `index.html`。

编码：对 `git ls-files` 下 `poc4/frontend` 与 `poc4/docs` 的文本后缀（`.ts/.tsx/.js/.mjs/.cjs/.json/.md/.css/.html/.txt/.yml/.yaml`）做 UTF-8 严格解码；`ENCODING_CHECKED=151`，`BOM_FOUND=0`，`UTF8_STRICT_FAIL=0`。工作区因 `core.autocrlf=true` 可见 CRLF（`CR_FOUND=89`）；`git diff --check` 干净。未添加 `.grok/`、`.superpowers/`、traces、videos、`test-results/`、`playwright-report/` 或 recaptured prior-stage PNG。

## Known Gaps

- 真实后端文件 API、JWT 校验、项目所有权、PVC 原子写、路径规范化和 symlink escape 尚未实现或验证。
- MSW revision / lock / owner 只能稳定前端契约，不能模拟 NFS 延迟、Pod 重启或真实事务隔离。
- opaque revision 无法在客户端排序；旧 GET 被 cancel 后网络竞态仍可能导致后端拒绝。拒绝比错误覆盖安全，真实合同需后端集成验证。
- 19–50 MiB 编辑会同时保留 Query baseline、buffer、JSON 请求和浏览器内部字符串。真实 `20 MiB + 1` 只证明当前机器可用，不是 SLA。
- plain-text dirty 是保守 epoch：undo 回完全相同内容可能仍显示 dirty；用户可 Save 清除。
- 当前 token `401` 必须立即清会话，无法保证保留未保存内容。
- Run 权威、主动 UI 锁、启动/停止与终态刷新属于阶段 4。`PROJECT_LOCKED` 只验证写拒绝与保脏。
- 413 / 网络失败 E2E 走页内 `fetch` 包装，不是传输层失败。
- 键盘树到达在 Tab 用尽后仍有 `.focus()` 兜底。
- 强制 401、真实字节和大写入场景开关仍是 mock contract：`POST /api/v1/session/expire`、`/large-files`、`/write-scenario` 只存在于 MSW。

## Decision

对照阶段 3 退出门十三项，依据 `b111d5d` 上完整矩阵逐项判定。全部为 **mock contract verified**：

1. 所有写 API 只接受 branded 项目内相对路径；创建/重命名 basename 经前端检查，MSW 再拒绝绝对路径、反斜杠、`.`、`..`、NUL、逃逸和非法 parent：通过。
2. 初次根目录响应建立非空 opaque `workspaceRevision`；每次保存/创建/重命名/删除携带当前 revision，成功推进，客户端从不自行生成：通过。
3. 同项目文件写操作严格串行；写入期间 tree/content refetch 不覆盖缓冲；跨项目不共享 mutation scope 或 revision：通过。
4. Monaco 和纯文本均可编辑；切标签保留缓冲。Monaco undo 回基线可 clean；大文本用保守 dirty，不对每次按键扫描 20 MiB：通过。
5. Save 与 `Ctrl+S` 只保存活动文件。成功仅在缓冲仍等于请求快照时清 dirty；保存中继续编辑响应后保持 dirty：通过。
6. 网络、`401`、`403`、`409`、`413`、`415` 和 `5xx` 不显示为保存成功。除当前 token `401` 清会话外，失败均保留缓冲和 dirty：通过。
7. dirty 关闭、返回项目列表、logout、SPA 历史与 unload 有防丢失；取消不改变标签、模型、认证或路由：通过。
8. 创建/同目录重命名/确认删除更新正确 parent tree；重命名映射展开/选中/标签；删除清理目标及后代标签、缓存和 models：通过。
9. dirty 文件或含 dirty 后代的目录不得重命名/删除；非空目录删除二次确认，服务端仍可 `DIRECTORY_NOT_EMPTY`：通过。
10. `BLOCKED` 不可写；越过 UI 的 PUT/CRUD 仍由 mock handler 做 owner、READY、path、revision、lock、类型和大小检查：通过。
11. Run/Terminal 不发送任何生产请求。disabled reason 区分 dirty 与 Stage 4 未接入；不声称真实运行锁闭环：通过。
12. Chromium、真实 Chrome、真实 Edge 核心工作流通过；1280 px 工具栏/标签/dialogs/树无重叠裁切；真实 `20 MiB + 1` Markdown 写入在 180s 内完成并记录请求字节与 viewer-ready/save 时间：通过。Chromium 38 passed / 12 skipped；Chrome 50；Edge 50；large-files 2；large-writes 1。
13. 生产构建不含 MSW worker、mock 凭据、Stage 3 scenario endpoint、echo URL 或 `stage0.html`；入口懒加载工作台，无静态 Monaco 导入；边界扫描零 Electron/Node/物理资源标识：通过。

真实后端 / PVC / symlink / JWT / 锁验证列为未解决，不阻塞本阶段退出门。未编写阶段 4 计划；未 merge / push。

因此决策为：

**READY_FOR_STAGE_4_PLAN**

## Confidence

对阶段 3 产品退出门 1–13 的置信度为 **90%**（单测 509、Chromium 38、Chrome/Edge 100、真实 20 MiB 加载与写入、生产扫描 0 匹配、工作台 chunk + 五 Worker）。对「现在就可以 `READY_FOR_STAGE_4_PLAN`」的置信度为 **88%**：完整命令矩阵已在最终应用 SHA `b111d5d` 上重跑；离开对话框 Cancel 焦点含在该 SHA；大文件耗时依赖本机；全部安全结论仍是 **mock contract verified**，真实后端/PVC/symlink/JWT/lock 未验证。
