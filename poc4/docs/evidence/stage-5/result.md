# EnsoAI Stage 5 Active Job Terminal Result

## Decision

**STAGE_5_REMEDIATION_REQUIRED**

17 项退出门中 **15 PASS / 2 FAIL**。失败门仅有：

1. **Gate 11 FAIL**：required browser case `a stale Alice terminal 401 cannot clear a newer Bob login` 仍为 `test.fixme`，本轮按既定停止规则未重试且不可重试；Chromium、Chrome、Edge 均没有该 case 的 fresh browser PASS。
2. **Gate 16 FAIL**：required 完整 keyboard-only File -> Run -> Terminal -> Open -> xterm -> Search -> Audit -> Close workflow 仍为 `test.fixme`，本轮同样未重试且不可重试；Chromium、Chrome、Edge 均没有该 workflow 的 fresh browser PASS。

不得放行或启动 Stage 6。E2E 命令 exit 0 不能把 required skip 解释为 PASS。

## Source And Evidence Boundary

- 日期：`2026-08-25`（Asia/Shanghai）
- 分支：`codex/poc4-stage-5-active-job-terminal`
- immutable matrix source SHA：`a1a2772b13d7cc565169aac2fa932bbb9e176d61`
- 矩阵工作目录：`poc4/frontend`
- 包管理器：pnpm `10.33.0`；browser commands 设置 `PLAYWRIGHT_HTML_OPEN=never`
- 本轮正式矩阵、最终 production rebuild、production scan 与 17 门判定共同绑定上述 source SHA；README 未修改，E2E 重拍的 45 张 tracked PNG 已全部恢复到该 SHA
- EnsoAI 浏览器显示参考保持 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；Stage 5 production 未复制 Electron IPC、`node-pty`、本机路径或旧 PTY 复用语义

本报告只证明 **mock contract verified / real-browser + MSW/mock evidence**。它不证明真实 Spring Boot、MySQL、Fabric8、Kubernetes PTY、Maven app container、reverse proxy 或 cluster 行为；mock session、echo 和 structured audit 均不得称为真实系统证据。

## Complete Matrix

11 条命令按下表顺序从同一 immutable SHA 正式执行，全部 exit 0。Start/end 为本机时区 wall-clock timestamp，duration 为 wrapper 记录的独立 elapsed time；mock/E2E 覆盖 `dist` 后另行执行了 final production rebuild 和 scan。

| Command | Start -> end | Duration | Exit | Exact result |
|---|---|---:|---:|---|
| `pnpm test:boundary` | `2026-08-25T19:54:47.508+08:00` -> `2026-08-25T19:54:48.394+08:00` | 0.884 s | 0 | node:test **24 pass / 0 fail / 0 skipped**；scanner PASS |
| `pnpm typecheck` | `2026-08-25T19:54:48.424+08:00` -> `2026-08-25T19:54:53.607+08:00` | 5.183 s | 0 | `tsc -b --pretty false` 无诊断 |
| `pnpm test` | `2026-08-25T19:54:53.612+08:00` -> `2026-08-25T19:55:39.910+08:00` | 46.307 s | 0 | Vitest **61 files / 1,105 pass / 0 fail**；Vitest duration 44.90 s |
| `pnpm build` | `2026-08-25T19:55:39.914+08:00` -> `2026-08-25T19:56:27.025+08:00` | 47.119 s | 0 | production，**3,787 modules**；Vite build 40.70 s；保留既有 >500 kB warning |
| `pnpm build:mock` | `2026-08-25T19:56:27.030+08:00` -> `2026-08-25T19:57:14.956+08:00` | 47.934 s | 0 | mock，**3,799 modules**；Vite build 41.33 s；mock-only `stage0.html` 仅存在于该临时产物 |
| `pnpm test:e2e` | `2026-08-25T19:57:14.959+08:00` -> `2026-08-25T19:59:14.393+08:00` | 119.456 s | 0 | Chromium **65 passed / 18 skipped / 0 failed**；required 两个 fixme 各 skip 1 次 |
| `pnpm test:e2e:channels` | `2026-08-25T19:59:14.398+08:00` -> `2026-08-25T20:04:26.548+08:00` | 312.193 s | 0 | Chrome + Edge **162 passed / 4 skipped / 0 failed**；4 skips 为 required 两个 fixme 各跨两浏览器一次 |
| `pnpm test:e2e:large-files` | `2026-08-25T20:04:26.551+08:00` -> `2026-08-25T20:05:27.995+08:00` | 61.452 s | 0 | **2/2 passed**；20 MiB - 1 Java 与 20 MiB + 1 Markdown |
| `pnpm test:e2e:large-writes` | `2026-08-25T20:05:27.999+08:00` -> `2026-08-25T20:06:31.574+08:00` | 63.583 s | 0 | **1/1 passed**；20 MiB + 1 Markdown PUT |
| `pnpm test:e2e:large-logs` | `2026-08-25T20:06:31.578+08:00` -> `2026-08-25T20:07:47.423+08:00` | 75.855 s | 0 | **1/1 passed**；6,291,522 generated / 5,242,880 retained / 1,048,642 evicted bytes |
| `pnpm test:e2e:terminal-stress` | `2026-08-25T20:07:47.426+08:00` -> `2026-08-25T20:09:02.017+08:00` | 74.601 s | 0 | **1/1 passed**；full required command 产生完整 flow/resize/render metrics |

两项 required fixme 保持停止状态，没有在本轮矩阵前后以 targeted 或其他方式重试。18/4 的总 skipped 集合还包含按 browser project 设计跳过的既有截图用例；Gate 11/16 的 required 部分精确为 Chromium 各一次、Chrome/Edge 各两次。

## Execution Recovery And Hygiene

- 一次 resumed boundary 预检因 checkout 中残留 mock `dist` 而失败；production preflight rebuild 恢复了正式矩阵所需的 production boundary baseline。该预检不是产品 gate failure，也不属于上表正式矩阵。
- 后续从 `604064a157bf5366c47783ce9693195d97d20965` 启动的 formal unit run 为 **60 files passed / 1 failed，1,104 tests passed / 1 failed**；同一 targeted test 再次 RED。根因是 test-only 固定 `finishedAt` 已早于真实时钟生成的 Run `createdAt` / `startedAt`，strict parser 正确 fail closed。
- 修复提交 `a1a2772` 将 test-only `finishedAt` 改为 `startedAt ?? createdAt` 加 1 秒；没有放宽 parser、改生产代码或改变断言。正式 11 命令矩阵从该修复 SHA 重新开始并全部 exit 0，因此上述恢复历史不计作产品 gate failure。
- E2E 重拍的 45 张 tracked PNG 全部恢复到 `a1a2772`；README、两个 required `test.fixme`、源码、测试和 package/lock 在本报告更新中均未修改。

## Production Rebuild And Scan

E2E 后 final production `pnpm build`：`2026-08-25T20:09:53.072+08:00` -> `2026-08-25T20:10:40.315+08:00`，47.245 s，exit 0，3,787 modules。最终 `pnpm test:boundary`：`2026-08-25T20:10:50.594+08:00` -> `2026-08-25T20:10:51.506+08:00`，0.909 s，exit 0，24/24。

Final production `dist` 共 **192 files**。Stage 0-5 累积 33 个 needles 逐项均为 `MATCH_FILES=0`，总计 `FORBIDDEN_MATCH_COUNT=0`；97 个 production text files 被扫描。`stage0.html`、MSW worker 与包含 MSW/echo 命名的文件均为 0。

| Production artifact | Evidence |
|---|---|
| `dist/assets/index-C0w0DEI1.js` | 388,416 bytes；`xterm` literal 0；只动态进入 Workbench |
| `dist/assets/WorkbenchPage-B_fsDVSS.js` | 4,014,278 bytes；`xterm` literal 0；`JobTerminalPanel` reference 2 |
| `dist/assets/JobTerminalPanel-DJX0xQxU.js` | dedicated lazy terminal JS，659,437 bytes；`xterm` literal 162 |
| `dist/assets/index-CUPLLfWc.css` | 43,938 bytes；`.xterm` selector 109；production xterm CSS 存在 |

16 个 production terminal files（tests excluded）针对 `src/terminal`、`src/spike`、`src/mocks`、`echo-ws`、`electron`、`node-pty`、`pvcName`、`podName`、`jobName`、`namespace`、`serviceAccount`、`dangerouslySetInnerHTML`、`tokeniz`、`appendTerminalAudit` 的扫描结果全部为 0。

## Session, Ticket And Lifecycle Evidence

以下 HTTP/WS 示例均隐藏 token、ticket 与 session，不能从报告恢复真实值：

```http
POST /api/v1/projects/<project>/runs/<run>/terminal-sessions
Authorization: Bearer <redacted-token>
Content-Type: application/json

{"cols":<integer 2..500>,"rows":<integer 1..200>}

HTTP/1.1 201
{"sessionId":"<redacted-session>","ticket":"<redacted-ticket>","expiresAt":"<future ISO-8601>"}
```

- Request exact keys 只有 `cols` / `rows`，不含 command、shell、cwd、env、container、image 或 resource。API coverage 同时验证 scoped path encoding、Bearer 与 AbortSignal。
- mock ticket TTL 为 30,000 ms；replay tombstone bounded lifetime 为 35,000 ms（含 5,000 ms grace）。HTTP reservation 不创建 live exec；只有成功 WebSocket handshake 原子 consume ticket 后才创建 live session、RUNNING audit，并发送 `terminal.ready`。过期 unused reservation 只清 reservation。
- WebSocket 固定为 `ws(s)://<same-origin>/api/v1/ws/terminals?ticket=<redacted-ticket>`；query 只有 ticket，JWT 不进入 URL、frame 或 DOM；ticket 单次使用，重复连接以 `4409` 关闭。
- 两个 unused reservations 可并存；第一根成功 handshake 建立 one-live session 后，其他 live consume/new reservation 被拒绝。Close/disconnect 清 live 与 stale reservations；只在同一 Run 仍 `RUNNING` 时由用户显式 Open 才创建新的 session、ticket、socket 与 xterm generation。
- Panel switch 保持同一 socket/xterm/session。Close、abnormal disconnect、project navigation、logout、current-token 401、shell exit、Run 离开 RUNNING 都禁用输入并清理；断线不自动重连，terminal exit/close 不改变 Run authority 或解锁文件。
- persisted `pagehide` 只关闭当前 session/generation，保留 controller/runtime 可用；`pageshow` 不自动重连，用户必须显式 Open 并获得 fresh session/ticket/socket。non-persisted `pagehide` 仍执行完整 dispose。
- active query 从 observed `RUNNING` 变为 null 时，先同步发布 null terminal authority，再 await detail；pending/rejected/nonterminal detail 都不恢复旧 terminal。fresh explicit `RUNNING` 会 invalidate stale same-run confirmation，之后才允许新的显式 Open。

## Bytes, Flow, Resize And Render Evidence

- `onData` sample `stage5-unicode-终端-😀-needle` 为 27 UTF-16 chars / **33 UTF-8 bytes**；browser binary sent/received 长度和前 32 bytes 一致。`onBinary` unit sample `00 1b ff 34 3d 00` 验证低 8 bit 原始 byte，browser xterm mouse frame 以 `1b 5b 4d` 开头并含 `>0x7f` byte。
- output 初始 credit 262,144；frame `<=32,768`；仅在 xterm `write(..., callback)` 完成后发送 exact FIFO ack。未 ack outstanding 上限 262,144，错误/乱序/重复 ack fail closed。
- input frame `<=16,384`，FIFO cap 1 MiB，`bufferedAmount` high/low watermarks 262,144 / 65,536；pause 时禁用输入，overflow 结束整个 session，不静默丢弃。
- full `pnpm test:e2e:terminal-stress` fresh metrics：generated / delivered / acked **8,388,650 / 8,388,650 / 8,388,650**；outstanding 0；max outstanding 262,144；max output frame 32,768；input queued / sent 131,085 / 131,085；max input frame 16,384；max buffered 307,200；resize observed / sent **204 / 102**；pause / resume 1 / 1；final marker 1；renderer WebGL；responsiveness 8 ms；console / page errors 0 / 0；Run log terminal marker 0。
- Stress 通过首个 viewport 必然变化、连续注入 101 次 resize 且循环内不串行等待 send，最终观测 204/102；这是 required full-command PASS，不是 targeted 替代证据。
- WebGL creation failure 与 context loss 均 dispose addon 并回退 DOM renderer；Search、focus、scrollback、clear display 和 resize 在 fallback 下仍可用。每次新 session 都创建全新 Terminal/Fit/Search/WebGL/ResizeObserver resources，旧 generation callbacks 不影响新 session。
- large-log fresh metrics：6,291,522 generated；5,242,880 retained；1,048,642 evicted；console / page errors 0 / 0。

这些指标是本机 real-browser + MSW/mock transport 测量，不是 proxy/backend/cluster SLA，也不证明真实 Kubernetes PTY 字节 fidelity。

## Audit And Channel Isolation Evidence

```http
GET /api/v1/projects/<project>/runs/<run>/terminal-audits?limit=50&cursor=<redacted-cursor>
Authorization: Bearer <redacted-token>
```

- Audit response 经过 strict parser：`id`、`sessionId`、`command`、`state`、`startedAt`、`finishedAt`、`exitCode` exact keys；state 仅 RUNNING/SUCCEEDED/FAILED/INTERRUPTED，timestamp/state/exitCode 组合必须一致，ID 唯一、startedAt 降序、nextCursor opaque。
- Browser 验证 50-record first page、Load more opaque cursor；mock state覆盖 owner/project/run/session filtering、pagination 与四种 state settlement。
- 前端只 query/cache/render backend structured audit；production scan 不含 frontend command tokenizer 或 audit append。hostile command 以 bounded plain text 显示，不使用 `dangerouslySetInnerHTML`。
- Browser markers pairwise isolated：PTY marker 不进入 Audit/Run log，Audit marker 不进入 PTY，Run-log marker 不进入 PTY；stress final marker 在 Run log 为 0。

mock structured audit 只验证展示与查询 contract，不证明真实 Shell/wrapper command boundary、multiline/interactive/signal attribution或 MySQL persistence。

## Browser And Visual Evidence

- Chromium：65 passed / 18 skipped；除 required Gate 11/16 fixme 外，Stage 5 browser cases 覆盖 lazy Open、session/ticket、bytes/resize/Search、backpressure、Close/no-reconnect、persisted pagehide 后显式 fresh Open、Run authority/channel isolation、project/logout/current 401、WebGL fallback。
- Chrome + Edge：162 passed / 4 skipped；两项 required fixme 各在两个 channel skip 一次，其余 executable cases 通过。
- Chrome/Edge 各验证 Terminal 与 Audit 的 `1280x720`、`1440x900`、`1920x1080`，共 12 张 Stage 5 visual evidence。几何、overflow、xterm 非空像素、Search overlay 与 Audit scroll/header assertions 通过；本轮重拍结果已恢复到 source SHA，没有 tracked PNG diff。

Visual/core PASS 不替代两个 required skipped workflows，故 Gate 11 与 Gate 16 仍 FAIL。

## Real-System Evidence Still Deferred

以下均未验证，本阶段不得作生产结论：

1. 真实 Spring Boot JWT 签名以及 owner/project/run/session/ticket 的后端授权与 stale-token race。
2. Fabric8 PTY exec 精确进入当前 Maven Job 的应用 container，而不是 sidecar、workspace Pod 或错误 container。
3. browser/pagehide/proxy disconnect 后真实 exec、shell 和 child processes 的销毁，以及旧 session 不可复用。
4. Run STOPPING/RECOVERING/终态与真实 terminal close、Kubernetes exec 结束、workspace reload 的竞态顺序。
5. >=8 MiB flow、credit/ack、input backpressure 与 pause/resume 跨真实 proxy/backend/Fabric8/cluster 的行为和 SLA。
6. 真实 Shell/wrapper command-boundary integration，包括 backspace、completion、multiline、interactive programs、signals 和 exit attribution。
7. MySQL audit transaction、owner query、pagination、retention、restart recovery 与敏感命令政策。
8. Terminal 对 RWX PVC 的副作用、跨节点可见性、UID/GID/`fsGroup` 与 Run 后文件 reload。
9. 完整 backend restart、proxy reset、cluster reschedule、cross-node 与 cold-start E2E。
10. Kubernetes API/RBAC、container identity、network policy、resource limit 和受控测试集群之外的安全边界。

## Acceptance Traceability

| POC4 rule | Stage 5 proof | Still deferred |
|---|---|---|
| Only active Maven Job terminal | authority + mock handler state checks | Real target container selection |
| Ticket instead of JWT URL | HTTP ticket + fixed same-origin WS | Real backend handshake/auth |
| Input/output/resize | binary/control protocol + browser E2E | Real Kubernetes PTY fidelity |
| Disconnect destroys old session | mock destroy + no reconnect/new IDs | Real exec/process destruction |
| Run end prevents input | authority close before reload | Real backend Run/PTY race |
| New session on same active Run | explicit Open after closed/restored page | Real exec recreation |
| Command audit | structured query/display + no frontend parser | Real Shell/wrapper + MySQL audit |
| Terminal output separate from logs | store/import/marker isolation | Real backend channel routing |
| Continuous output | 8,388,650-byte browser/mock stress | Proxy/backend/cluster SLA |
| Browser boundary | source/dist/chunk scans | Full real-system threat validation |

## Repository Hygiene

- Tracked `poc4/frontend` + `poc4/docs` excluding `.png` and `.mock`：**224 text files**；strict UTF-8 decode failures **0**；UTF-8 BOM files **0**。
- Checkout `core.autocrlf=true`；repository root 无 `.editorconfig` / `.gitattributes`。上述 text files 中 **203 files contain CRLF / 58,179 CR bytes / 67,059 LF bytes**。
- 本 `result.md`：UTF-8 without BOM，**CR 0 / LF 192**；保持 LF-only。
- 扫描排除 generated/ignored `dist`、Playwright `test-results`、traces/videos/reports、`.grok`、linked worktrees 和其他 untracked artifacts；它们不纳入 tracked hygiene 统计或提交。
- 本次 tracked diff 只允许 `poc4/docs/evidence/stage-5/result.md`；README、PNG、源码、测试、package/lock、两个 fixme 与 `.grok` 均不修改。

## Exit Gates

| Gate | Status | Fresh evidence and limit |
|---:|---|---|
| 1 | PASS | 36 contract tests + 24/24 boundary/full unit matrix：session/audit/control exact keys、IDs、timestamps、dimensions、frame size、close/error combinations strict-parse |
| 2 | PASS | exact `{cols,rows}` POST；only same-project active `RUNNING` enables create；无 shell/cwd/env/container/image/resource fields |
| 3 | PASS | mock authority coverage：owner、READY project、current active RUNNING、runId、history/non-RUNNING bypass rejection 与 one-live enforcement |
| 4 | PASS | Bearer HTTP、30 s single-use bound ticket、same-origin ticket-only WS、JWT absent from URL/frame/DOM；本报告 secrets redacted |
| 5 | PASS | unused reservation 不创建 exec；successful atomic handshake 才创建 one live session/audit/ready；second live rejected |
| 6 | PASS | 33-byte Unicode、low-byte `onBinary`、xterm mouse bytes、binary direction 与 Run-log isolation |
| 7 | PASS | output frame <=32 KiB、credit 256 KiB、write-callback exact FIFO ack、8,388,650-byte conservation 与 fail-closed checks |
| 8 | PASS | input frame <=16 KiB、queue 1 MiB、256/64 KiB watermarks、pause/resume、overflow fail closed、no silent drop |
| 9 | PASS | positive/deduped/coalesced resize、inactive/zero gate、reactivation refit；full stress fresh 204 observed / 102 sent |
| 10 | PASS | per-session xterm/addons、WebGL creation/context-loss DOM fallback、Search/focus/clear/resize lifecycle |
| 11 | **FAIL** | pagehide、project/logout/current 401/Run-left cleanup executable cases pass；required stale Alice terminal 401 preserving newer Bob remains non-retriable `test.fixme` with no fresh Chromium/Chrome/Edge PASS |
| 12 | PASS | explicit Close/disconnect 不自动重连；persisted restore 后显式 Open uses fresh session/ticket/socket/xterm；old generation inert |
| 13 | PASS | null-active synchronously revokes terminal authority before detail await；pending/rejected/nonterminal do not restore it；fresh RUNNING invalidates stale confirmation；STOPPING close-before-reload browser evidence passes |
| 14 | PASS | backend-only structured audit、owner/session cursor pagination、safe plain rendering、no frontend parser、PTY/Audit/Run-log isolation |
| 15 | PASS | required full `pnpm test:e2e:terminal-stress` exit 0；8,388,650 generated=delivered=acked、204/102 resize、marker once、8 ms responsive、zero console/page errors |
| 16 | **FAIL** | Chrome/Edge/Chromium executable core and visual cases pass；required complete keyboard-only File -> Run -> Terminal -> Open -> xterm -> Search -> Audit -> Close remains non-retriable `test.fixme` with no fresh browser PASS |
| 17 | PASS | final production rebuild 3,787 modules + final boundary 24/24；192 files/97 text，33 needles zero，entry/Workbench xterm 0，dedicated lazy terminal JS + xterm CSS verified |

## Known Risks Carried Forward

- 真实 Kubernetes PTY、disconnect process destruction、container selection 与 Run race 仍是最大证据缺口。
- Native WebSocket 无内建 backpressure；browser credit/ack 不能证明真实 proxy/backend 遵守协议。
- xterm beta versions 已锁定但 API 仍可能漂移；本阶段不升级。
- Terminal 可修改 PVC；这是受控测试集群风险，不提供 immutable run。
- command audit attribution、input prefix-on-overflow、browser background throttling 与 session/Run races 必须在真实系统重新验证。
- required stale-401 ownership race 与完整 keyboard-only workflow 缺少 browser PASS；在两门补齐并重新执行 gate evidence 前，Stage 5 保持 remediation 状态。
