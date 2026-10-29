# EnsoAI Stage 4 Run And Logs Result

## Source Commit

- 日期：`2026-08-24`
- 分支：`poc4/ensoai-stage-4-run-logs`
- 验证树（完整矩阵）：`481a4fa6f5ac6d36c25c8f2f89bf9769bc262c0a`（`481a4fa` `fix(poc4): accept reload status after confirmed stop`）
- 本报告是该 SHA 之后的文档提交，不改应用源码
- 工作目录：`poc4/frontend`；包管理器仅 pnpm
- EnsoAI 来源仍为 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；阶段 4 未复制 EnsoAI 本机 PTY / Electron Run 逻辑
- 本报告所有退出码、测试数、构建体积、扫描结果与大日志实测均在 `481a4fa` 上新鲜执行

任务指定认证 `1e75a22`。在该 SHA 上第一次完整矩阵中，`pnpm test` 退出 1：`RunPanel.test.tsx`「opens Stop confirmation…」在确认 Stop 后 `waitFor` 期望 `/STOPPING|CANCELLED/`，mock 已进入终态 reload，UI 显示 `Reloading workspace`。这不是产品解锁错误（Start/New file 仍 disabled）。最小修复把断言扩为 `/STOPPING|CANCELLED|Reloading/`，与 Chromium/Chrome/Edge E2E 一致，提交 `481a4fa`，并在该 SHA 上重跑全部命令。不得把 `1e75a22` 的单测记成通过。

阶段 4 实现提交（`65ec8be..481a4fa`）：

| SHA | 说明 |
|---|---|
| `65ec8be` | 阶段 4 计划 |
| `a3d2f0b` / `6ad3f86` | Run / 日志契约、5 MiB replay 与 gap 解析 |
| `62beaaf` | mock 权威 Run 与持久化窗口 |
| `91c7c6c` | mock HTTP / WebSocket ticket 流 |
| `20704de` / `8d848bc` | 权威协调器 fail-closed |
| `3ecfb36` | replay / reconnect 传输与 store |
| `8ee2bf6` / `9d0de17` | Run / 日志面板 |
| `97a00ac` | 工作台 Run 锁 |
| `2c9c7be` | 终态强制 reload |
| `0d0a2cf` | 恢复、心跳、logout 清理 |
| `1c2d355` | Stage 4 E2E、12 张 PNG、真实大日志 |
| `cf6e915` | 收紧 gap / replay-then-live / large-log complete |
| `1e75a22` | stale generation 走第二根真实 socket |
| `481a4fa` | Stop 确认后接受 Reloading 状态（本报告认证 SHA） |

## Scope Boundary

阶段 4 仍是纯浏览器前端。证据只证明浏览器面对 mock `200/202/401/403/409/5xx`、active/list/start/stop/ticket HTTP、同源 WebSocket replay/live，以及 mock 5 MiB 窗口时的状态机。用语一律为 **mock contract verified**。不得从 MSW 得出真实 Spring Boot 授权、JWT 签名、MySQL 事务、Kubernetes Job、Pod 日志、30 分钟超时或后端重启恢复已验证。

包含：`READY` 项目权威 active Run、只发送 `expectedWorkspaceRevision` 的 Start、幂等 Stop、运行期 File 锁、终态强制 reload、最近 Run 分页、Bearer 短期 ticket、同源 `/api/v1/ws/run-logs?ticket=`、replay 后再 live、seq 去重/缺口/stale generation、5 MiB 截断、刷新浏览器恢复、Chromium / Chrome / Edge 与真实 `>= 5 MiB + 1 MiB` UTF-8 日志流。

明确排除：真实 Spring Boot / JWT 签名 / MySQL、真实 Kubernetes Job / Pod logs / PVC、真实 `mvn clean test`、真实 30 分钟超时与资源限制、后端重启恢复、xterm / PTY / Terminal panel、浏览器任意命令/镜像/资源配置、日志下载/搜索/ANSI、七天定时删除。Terminal tab 继续 disabled。

## Automated Verification

工作目录：`poc4/frontend`。下列命令均在 `481a4fa` 对应工作树执行。`rg` 不在 PATH；生产排除扫描见后文。浏览器测试后 `git diff --check` 无空白错误。channels 会改写已提交 PNG；Stage 2 / Stage 3 已 `git checkout` 还原。Stage 4 12 张 PNG 亦被复拍且几何断言通过；本报告是文档提交，复拍未纳入本 commit。

| 命令 | 退出码 | 观察结果 |
|---|---:|---|
| `pnpm test:boundary` | 0 | node:test **20 pass / 0 fail**（`duration_ms 149.7948`；命令墙钟 884.8 ms）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | `tsc -b --pretty false` 无诊断输出（5735.8 ms） |
| `pnpm test` | 0 | Vitest 3.2.7：Test Files **48 passed (48)**；Tests **841 passed (841)**；Duration 52.98s（墙钟 54735.7 ms）。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示（Spike），不计入失败 |
| `pnpm build`（矩阵首次） | 0 | 内含 typecheck；Vite 7.3.6 production；`3766 modules transformed`；`built in 49.34s`（墙钟 56636.2 ms）。入口 `index-CLtpNJqV.js` 388.16 kB / gzip 123.18 kB；工作台 `WorkbenchPage-B7cBRfsH.js` 4,011.20 kB / gzip 1,044.89 kB |
| `pnpm build:mock` | 0 | Vite mock；`3783 modules transformed`；`built in 50.36s`（墙钟 57806.7 ms）。含 `stage0.html`、MSW worker、Monaco workers。存在 `>500 kB` chunk 提示，构建仍成功 |
| `pnpm test:e2e` | 0 | Playwright Chromium：Running 70 tests using 2 workers；**55 passed / 15 skipped**（2.3m，墙钟 139152.5 ms）。跳过的是 Spike / Stage 1 / Stage 2 / Stage 3 / Stage 4 截图（仅 chrome/edge） |
| `pnpm test:e2e:channels` | 0 | Playwright chrome + edge：Running 140 tests using 2 workers；**140 passed**（7.5m，墙钟 452394.5 ms） |
| `pnpm test:e2e:large-files` | 0 | Playwright `chromium-large-files`：**2 passed**（1.2m，墙钟 75073.4 ms） |
| `pnpm test:e2e:large-writes` | 0 | Playwright `chromium-large-writes`：**1 passed**（1.3m，墙钟 78417.2 ms，180s ceiling） |
| `pnpm test:e2e:large-logs` | 0 | Playwright `chromium-large-logs`：**1 passed**（1.5m，墙钟 89509.6 ms，180s ceiling） |
| `pnpm build`（E2E 后生产重建） | 0 | mock/E2E 覆盖 `dist/` 后再构建；`3766 modules transformed`；`built in 49.28s`（墙钟 56675.0 ms）；产物哈希与矩阵首次生产构建一致（`index-CLtpNJqV.js` / `WorkbenchPage-B7cBRfsH.js`） |
| `git -C ../.. diff --check` | 0 | 干净 |
| `git -C ../.. status --short` | 0 | 矩阵结束时仅 Stage 4 PNG recapture；按文档提交范围还原。本报告提交前工作树仅本文件变更 |

`1e75a22` 上同矩阵除 `pnpm test` 外其余命令也曾退出 0。认证数字全部来自 `481a4fa`，不混用两次墙钟。

## Authority And Lock Evidence

本项为 **mock contract verified**。

1. 进入工作台先查 `GET /api/v1/projects/{projectId}/runs/active`。E2E `holdActive` 期间 New file / Start 禁用，Start title 含 `AUTHORITY_LOADING`，零 Start POST。放开后才可编辑。
2. Start 请求只含 `expectedWorkspaceRevision`。契约 `parseStartRunRequest` 在键数不为 1 或出现 `command` / `image` / `resources` 时整包拒绝。HTTP：

```http
POST /api/v1/projects/prj-alice-notebook/runs HTTP/1.1
Host: 127.0.0.1:4173
Authorization: Bearer <redacted>
Accept: application/json
Content-Type: application/json
```

```json
{
  "expectedWorkspaceRevision": "<opaque workspace revision>"
}
```

成功响应 `202`，体为经运行时验证的 `RunSummary`（`STARTING`）。JWT 只在 `Authorization` 头，不进入 URL、JSON body、WebSocket URL 或截图。

3. 前端在 dirty、写 pending、revision 缺失、authority 未知或已有 active Run 时不发送 Start。绕过 UI 的重复 Start 返回 `409 RUN_ALREADY_ACTIVE`，UI 仍锁定并保持权威 active。Start 网络中止后 fail-closed，refetch active，不重放 mutation。
4. Start/Stop/文件写共用 `project-authority:${projectId}` mutation scope。Stop：

```http
POST /api/v1/projects/prj-alice-notebook/runs/{runId}/stop HTTP/1.1
Authorization: Bearer <redacted>
```

响应 `200` 经验证的 `RunSummary`。确认框默认焦点 Cancel，Escape = Cancel，确认后不乐观写成 `CANCELLED`。幂等 Stop 由 mock 状态机与 refetch 决定。
5. 活动 Run 期间 File Save / New file / New folder / Rename / Delete 禁用。绕过 UI 的 PUT/CRUD 返回 `409 PROJECT_LOCKED`。下载/查看不被当成写操作。
6. `LOADING_AUTHORITY`、`STARTING`、`RUNNING`、`STOPPING`、`RECOVERING`、`RELOADING_WORKSPACE`、`RELOAD_FAILED` 全部 fail-closed。socket close、offline、ticket 失败、`log.complete` 都不解锁。E2E：`window` offline 后 connection 为 Reconnecting，New file 仍 disabled。
7. 终态后协调器进入 `RELOADING_WORKSPACE`。顺序：取消文件读 → `disposeProject` / `disposeProjectModels` → `removeQueries` → 重取根树 → 按原打开路径 meta/content → 缺失路径当 `ENTRY_NOT_FOUND` 关标签。`reload-change`：`README.md` 出现新内容、`docs/run-output.md` 入树、`AppTest.java` 标签与树消失。根树失败保持锁定，Run toolbar Retry 从干净 disposed 状态重跑。
8. success / failure / timeout 三条路径均在解锁前完成 reload。历史列表 `aria-label` 含 `SUCCEEDED` / `FAILED` / `TIMED_OUT`。客户端 30 分钟计时器不能把状态写成 `TIMED_OUT`。

前端锁与 mock handler 不能替代真实后端 revision 事务或 Kubernetes 单 Job 锁。

## Log Protocol And Recovery Evidence

本项为 **mock contract verified**。Mock persist ≠ MySQL。

1. Ticket：`POST /api/v1/projects/{projectId}/runs/{runId}/log-ticket`，Bearer HTTP，约 30 秒、单次使用、绑定用户/project/run。客户端只把 `http`/`https` 换成 `ws`/`wss`，路径固定 `/api/v1/ws/run-logs?ticket=`。主 JWT 不出现在 ticket URL、frame 或 DOM。断言拒绝 `accessToken` / `Bearer ` / `eyJ`。
2. 连接后先 `log.replay` 再 `log.append`。disconnect 场景：第一根 socket 中途 `1011` 或 `STREAM_UNAVAILABLE`；断线期间 persist `PERSISTED_OFFLINE` 不在第一帧 replay；后续 replay 含该块，再 live `RECONNECT_LIVE`。seed 文本只出现一次。
3. gap 场景：线上重复 append seq 被忽略（UI 各 marker 计数为 1）；跳过的 `GAP_SKIPPED` 出现在后续 `log.replay`；至少换一次新 ticket。
4. stale generation：generation 前进后在第一根（旧）socket 注入连续 seq 的 `log.append`；marker 只在 `socketTraces[0]`，不进第二根 socket，也不进日志 region。
5. Heartbeat watchdog 30s；超时换新 ticket/generation，迟到旧代 frame 无效。logout / 当前 token 401 关闭 run-log socket 并清会话；Alice 迟到 401 不清除 Bob。
6. 历史：`GET .../runs?limit=20&cursor=` 降序、opaque cursor。E2E 种子 21 条后第一页 20、Load more 到 21。选中历史 Run 与活动 log 隔离，切换关闭旧 socket。
7. 刷新/重进：`sessionStorage` 键 `ensoai.mock.run-scenario.v1` 再水合。证明的是 **浏览器恢复合同**，不是 MySQL 或后端重启。列表过滤 `MOCK_RUN_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000` 只是 mock 查询窗口，不是定时删除。
8. mock append 先更新 persisted window 再发 frame。`byteLength` 必须等于 UTF-8 字节；`retainedBytes <= 5 MiB`；`truncated=false` 要求 `evictedBytes=0`。客户端不伪造淘汰事实。
9. 无 HTTP 503 `LOG_TICKET_NOT_AVAILABLE` mock 路径（契约码存在，handler 未实现）。

## Browser And Visual Evidence

Chromium（`pnpm test:e2e`，退出 0）：

| 范围 | 结果 |
|---|---|
| Stage 4 功能 16 条 + 键盘 | 通过（authority、Start 形态、409/歧义、File↔Run、replay/gap/stale、Stop、socket 不解锁、终态 reload、reload-change、refresh 浏览器恢复、history、401、Terminal 禁用） |
| Stage 3 / Stage 2 / Stage 1 / Spike 回归 | 通过 |
| 截图（Spike + Stage 1–4） | skipped（chrome/edge only） |

Chrome + Edge（`pnpm test:e2e:channels`，退出 0）：

| Project | Passed | Failed | Notes |
|---|---:|---:|---|
| chrome | 70 | 0 | 含 Stage 4 功能 + 3 条 run/truncated 截图 |
| edge | 70 | 0 | 同上 |

12 张视觉证据在 `1c2d355` 写入 `poc4/docs/evidence/stage-4/`。`481a4fa` 的 channels 复跑通过同一套几何/截图断言。PNG 字节不是 golden-file；断言的是 CSS 像素尺寸、无文档横向溢出、header/sidebar/history/log 无内部重叠、toolbar / Stop / Terminal tab / truncation banner 可达、日志区域含非背景文本像素。

| 文件 | 像素 |
|---|---|
| `chrome-run-1280x720.png` / `chrome-truncated-log-1280x720.png` | 1280×720 |
| `chrome-run-1440x900.png` / `chrome-truncated-log-1440x900.png` | 1440×900 |
| `chrome-run-1920x1080.png` / `chrome-truncated-log-1920x1080.png` | 1920×1080 |
| `edge-run-1280x720.png` / `edge-truncated-log-1280x720.png` | 1280×720 |
| `edge-run-1440x900.png` / `edge-truncated-log-1440x900.png` | 1440×900 |
| `edge-run-1920x1080.png` / `edge-truncated-log-1920x1080.png` | 1920×1080 |

1280 px：Chrome/Edge active Run 与 truncated log 均通过无溢出、控件在视口内与可达断言。header 底边不超过文件树顶；文件树右缘不超过 Recent runs；Recent runs 右缘不超过日志区。

键盘：File tab → Run tab → Start → history → log → New output → Stop 对话框 Cancel 焦点 / Escape / Confirm。`role="status"` 用于 Run state；错误用 `role="alert"`。`prefers-reduced-motion: reduce` 已模拟。

Playwright 1.62.1；Chromium `151.0.7922.34`。webServer 执行 `pnpm build:mock && pnpm preview`（4173）与 `pnpm dev:echo`（4174，仅 Spike 回归）。未连接真实 POC4 后端。Terminal / `:4174` 非 health 流量为零。

## Real-Byte Log Measurements

载荷未缩小。large-logs 超时 180s。浏览器：Playwright Chromium 151.0.7922.34。

`pnpm test:e2e:large-logs`（`481a4fa`，1 passed）`LARGE_LOG_MEASUREMENT`：

| Field | Value |
|---|---|
| generatedBytes | **6291522**（`>= 6291456` = 5 MiB + 1 MiB） |
| retainedBytes | **5242880**（恰好 5 MiB，`<=` cap） |
| evictedBytes | **1048642** |
| frameCount | 109 |
| firstAvailableSeq | 19 |
| lastAvailableSeq | 98 |
| readyMs | 145 |
| reconnectCatchUpMs | 6 |
| probeMs | 166（`< 5000`） |
| ticketCount | 6 |
| wsCount | 6 |
| completeCount | **1** |
| streamUnavailableCount | **1** |
| consoleErrors | `[]` |
| pageErrors | `[]` |

字节来自真实 UTF-8 `chunk.text` 加最后 `window` meta，不是假 size。截断横幅 `Log truncated`；head / evicted-early marker 淘汰后不在 UI；latest marker 唯一；chunk index 无重复。中途断开后仍继续追加，重连 replay 含断线期间字节，然后 `log.complete`，状态为 `SUCCEEDED|Reloading` 而非停在 `RUNNING`。File↔Run 往返 probe `< 5s`，页面未崩溃。这只证明当前测试机器可运行，不构成生产 SLA。

回归大文件 / 大写入（同 SHA，载荷未缩小）：

| 命令 | 观察 |
|---|---|
| large-files NearLimit.java | 可写 Monaco；字符串/正文 **20,971,519**；`Content-Length` 20,971,619；viewer-ready **676 ms**；console/page 无错 |
| large-files large-notes.md | 可写 textarea；**20,971,521**；`Content-Length` 20,971,603；viewer-ready **4306 ms** |
| large-writes large-notes.md | 保存后正文 **20,971,538**；JSON 请求 UTF-8 **20,971,601**；click→ready **4399 ms**；save→response **1674 ms** |

## Production Exclusion Evidence

矩阵中 `pnpm build:mock` 与 E2E 会覆盖 `dist/`，因此在 `481a4fa` 上于 large-logs 之后重新执行 `pnpm build`（production，非 mock）再扫描。`dist/stage0.html` 与 `dist/mockServiceWorker.js` 均不存在。产物 190 个文件。

扫描字符串（Stage 3 列表 **加上** Stage 4 scenario / ticket / persist / large-log 标记）：

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
/api/v1/session/run-scenario
mock-run-log-ticket-
ensoai-stage4-seed-log
ensoai.mock.run-scenario.v1
ensoai-stage4-large-log-head
ensoai-stage4-large-log-evicted-early
ensoai-stage4-large-log-latest
ensoai-stage4-large-log-while-disconnected
ensoai-stage4-large-log-chunk-
setRunScenario
largeLogPayload
```

UTF-8 解码后逐文件 `Contains`：`FORBIDDEN_MATCH_COUNT=0`（每条 needle 的 MATCH_FILES=0）。

入口 chunk `index-CLtpNJqV.js` **没有** `monaco-editor` / `@monaco-editor` 静态导入，也没有 Worker 文件名、`features/runs`、`features/logs`、`RunLogTransport`、`RunLogStore`。其中出现的 `kind:"monaco"` 来自打进入口的 `WorkspaceBufferRegistry` 判别字段，不是编辑器包。工作台 `WorkbenchPage` 仍由 `ProjectRoutePage` `lazy(() => import('./WorkbenchPage'))` 加载。五个 Monaco Worker 均存在于生产 `dist/assets/`。

生产 Run 模块（`src/features/runs`、`src/features/logs`、`src/components/runs`、`src/api/runApi.ts`、`src/contracts/run.ts`、`src/contracts/log.ts`，不含 `*.test.*`）零匹配：`src/terminal`、`src/spike`、`src/mocks`、`@xterm/*`、`scripts/echo-ws`、`node-pty`、`window.electronAPI`、`pvcName` / `podName` / `jobName` / `namespace` / `serviceAccount`。

关键产物（Vite 打印；Worker gzip 列为 Python `gzip.compress(level=9)`）：

| 路径 | raw | gzip |
|---|---:|---:|
| `dist/index.html` | 0.40 kB | 0.27 kB |
| `dist/assets/index-B3qiyJ_-.css` | 37.17 kB | 7.05 kB |
| `dist/assets/index-CLtpNJqV.js`（入口，无静态 Monaco / Run 重模块） | 388.16 kB | 123.18 kB |
| `dist/assets/WorkbenchPage-Ck3IbhyB.css` | 142.37 kB | 22.88 kB |
| `dist/assets/WorkbenchPage-B7cBRfsH.js`（工作台） | 4,011.20 kB | 1,044.89 kB |
| `dist/assets/editor.worker-C2_AfrSl.js` | 251,735 B | 75,278 B |
| `dist/assets/json.worker-C838mOW9.js` | 383,014 B | 112,906 B |
| `dist/assets/html.worker-eZJr__P7.js` | 693,120 B | 179,908 B |
| `dist/assets/css.worker-NZNbQL3P.js` | 1,030,315 B | 230,640 B |
| `dist/assets/ts.worker-BfwyojP3.js` | 7,010,073 B | 1,531,330 B |

Vite 打印 `Some chunks are larger than 500 kB after minification`。`chunkSizeWarningLimit` 未提高。

`main.tsx` 仅在 `import.meta.env.VITE_ENABLE_MOCK_API === 'true'` 时动态 `import('./mocks/browser')`。Vite `publicDir` 生产为 `public`，mock 为 `public-mock`。生产入口只有 `index.html`。

编码：对 `git ls-files` 下 `poc4/frontend` 与 `poc4/docs` 的文本后缀（`.ts/.tsx/.js/.mjs/.cjs/.json/.md/.css/.html/.txt/.yml/.yaml`）做 UTF-8 严格解码；`ENCODING_CHECKED=188`，`BOM_FOUND=0`，`UTF8_STRICT_FAIL=0`。工作区因 `core.autocrlf=true` 可见 CRLF（`CR_FOUND=142`）；`git diff --check` 干净。未添加 `.grok/`、`.superpowers/`、traces、videos、`test-results/`、`playwright-report/` 或 recaptured prior-stage PNG。扫描脚本只存在于 `%TEMP%`，未提交。

## Unresolved Real-System Evidence

下列不是 Stage 4 失败，因为本计划是前端迁移阶段；它们是 Stage 6 强制项：

- 真实 Spring Boot 认证与 JWT 签名
- 真实 MySQL 事务（先持久化后推送）、5 MiB 存储淘汰、7 天定时删除（mock 列表过滤不是 scheduled deletion）
- 真实 Kubernetes 每项目一个 Job 锁、固定 Maven 命令 / CPU / 内存 / ephemeral / 30 分钟超时
- 真实 Pod 日志顺序与完整性
- 后端重启后从 MySQL / Kubernetes 恢复
- HTTP 503 `LOG_TICKET_NOT_AVAILABLE` 路径（mock 未实现）
- Terminal / xterm / PTY（整个 Stage 5）

## Known Gaps

- 真实后端 / Kubernetes 仍是最大风险。UI 显示 `RUNNING` 不表示集群里有 Maven Job。
- HTTP 与 WebSocket 双权威事件可能竞态；终态 reload 依赖 generation 去重。
- Start/Stop 网络错误有提交歧义；必须 refetch active，不得自动重放 mutation。
- 5 MiB 文本仍会内存放大（chunk store、React 文本、WebSocket frame 共存）。压力测试是机器证据，不是 SLA。
- 浏览器后台节流影响心跳/轮询。
- MSW `ensoai.mock.run-scenario.v1` 再水合是人造的浏览器恢复，不是后端重启。
- `workers: 2` 是 Playwright 测试旋钮，不是产品配置。
- Toolbar `Run state` 可能在解锁后短暂仍显示 `RUNNING`，因 selected-run detail cache 落后于 active query；E2E 以 history `aria-label` 终态 + New file 可用来证明解锁。

## Decision

对照阶段 4 退出门十五项，依据 `481a4fa` 上完整矩阵逐项判定。全部为 **mock contract verified**：

1. 所有 Run/日志响应经运行时验证；不透明 `runId` / cursor / ticket / timestamp 无空值越界，非法状态组合整包拒绝：通过。
2. Start 只发送 `expectedWorkspaceRevision`；dirty / 写 pending / revision 缺失 / authority 未知 / 已有 active 时前端不发请求，mock 仍拒绝绕过 UI 的额外字段与重复 Start：通过。
3. Start/Stop/文件写共用 project authority mutation scope；网络不确定或 `409` 后 refetch active，不重放 mutation：通过。
4. `LOADING_AUTHORITY`、locking 态、`RELOADING_WORKSPACE`、reload failure 全部 fail-closed；下载/查看不当成写：通过。
5. WebSocket 断开、ticket 失败、`log.complete`、offline 都不解锁；只有权威终态且 workspace reload 成功后才解锁：通过。
6. Stop 只针对当前 owned active Run；确认框 Cancel 优先；不乐观写成 `CANCELLED`：通过。
7. log ticket 经 Bearer HTTP、约 30 秒、单次、绑定用户/project/run；主 JWT 不进 WebSocket URL/frame/DOM：通过。
8. replay 后再 live；重复 seq 忽略；缺口换新 ticket；旧 generation 迟到 frame 无效：通过。
9. mock persist-then-send；UTF-8 `byteLength`、窗口序号、`truncated`、`evictedBytes` 一致，客户端不伪造淘汰：通过。
10. 真实 `6291522` 字节流、保留 `5242880`、淘汰 `1048642`、重连补拉、页面可响应：通过。
11. 刷新/重进经 active query + mock persist 恢复锁与 cursor；明确不是 MySQL：通过。
12. 终态后 dispose → removeQueries → refetch → reopen；增删改文件符合服务端；reload 失败保持锁定并可 Retry：通过。
13. 最近 Run 降序 cursor 分页；历史与活动隔离：通过。
14. Chromium 55 passed / 15 skipped；Chrome 70；Edge 70；1280 px 无重叠；键盘走通 File/Run/Start/Stop/history/log/New output：通过。
15. 生产构建不含 MSW worker、mock 凭据、Stage 4 scenario/ticket/persist 标记、echo URL、`stage0.html`；入口无静态 Monaco/Run 重模块；Run 生产模块无 terminal/xterm/echo/mock import、无 pvc/pod/job/namespace/serviceAccount：通过。

真实后端 / Job / MySQL / 7 日删除 / 503 ticket / Terminal 列为未解决，不阻塞本阶段退出门。未编写阶段 5 计划；未 merge / push。

因此决策为：

**READY_FOR_STAGE_5_PLAN**

## Confidence

对阶段 4 产品退出门 1–15 的置信度为 **88%**（单测 841、Chromium 55、Chrome/Edge 140、真实 6 MiB 日志流、生产扫描 0 匹配）。对「现在就可以 `READY_FOR_STAGE_5_PLAN`」的置信度为 **85%**：完整命令矩阵已在最终应用 SHA `481a4fa` 上重跑；`1e75a22` 单测失败已用最小断言修复并复证；大日志耗时依赖本机；全部安全结论仍是 **mock contract verified**，真实后端/Kubernetes/MySQL/Job 未验证。
