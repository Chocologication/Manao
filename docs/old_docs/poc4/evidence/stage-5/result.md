# EnsoAI Stage 5 Active Job Terminal Result

## Decision

**READY_FOR_STAGE_6_PLAN**

按 `2026-08-26` 用户修订后的验收口径，17 项退出门记为 **15 PASS / 2 WAIVED_BY_USER**：

1. **Gate 11 WAIVED_BY_USER**：required browser case `a stale Alice terminal 401 cannot clear a newer Bob login` 仍为 `test.fixme`。未运行、未修改该 case，Chromium、Chrome、Edge 均没有它的 fresh browser PASS。
2. **Gate 16 WAIVED_BY_USER**：required 完整 keyboard-only File -> Run -> Terminal -> Open -> xterm -> Search -> Audit -> Close workflow 仍为 `test.fixme`。同样未运行、未修改，三个 browser channel 均没有它的 fresh PASS。

`WAIVED_BY_USER` 不等于 PASS。本决策只允许停止 Stage 5 并进入 Stage 6 计划阶段，不授权在本阶段实现真实后端、MySQL 或 Kubernetes PTY。

当前实现 HEAD 为 `0c28ad7fef9a1dac3074f5937f5a47a48b181728`。最后一次 scoped re-review 未发现未关闭的 Critical/Important（对应 P1/P2）；保留 1 个 Minor：当 Vite base 先含非路径段 `assets`、随后才含真实 `/assets/` 时，production asset resolver 可能 fail closed false-positive，当前 Vite base 不受影响。

用户要求停止继续验证，因此没有重跑第二轮矩阵。最新已有 `0c28ad7` 矩阵是 **9/11 commands exit 0**，以下异常保留为已知 verification exceptions，不伪报全绿：

- `pnpm test`：60 files passed，`ProjectsPage.test.tsx` 的 `beforeAll(import('./WorkbenchPage'), 30_000)` 超时；1 suite failed，1,117 tests passed，7 tests skipped。
- `pnpm test:e2e:channels`：160 passed / 4 skipped / 4 failed；Chrome Stage 4 两个 visual case 未在默认等待内观察到 latest marker，Chrome/Edge Stage 5 两个 recovery case 未观察到短暂 `RECOVERING` frame。
- 其余 9 个命令 exit 0；其中 Chromium 66 passed / 18 skipped，terminal stress 8,388,650 generated = delivered = acked bytes，max outstanding 262,144，input 131,085 / 131,085，resize 204 / 102，responsiveness 28 ms，console/page errors 0/0。

## Source And Evidence Boundary

- 日期：`2026-08-26`（Asia/Shanghai）
- 分支：`codex/poc4-stage-5-active-job-terminal`
- 当前实现 source SHA：`0c28ad7fef9a1dac3074f5937f5a47a48b181728`
- 当前实现提交：`fix(poc4): make terminal asset resolution exact`
- 历史完整绿色矩阵 source SHA：`09ded26a7c9f930482a1f55dde6520f7aea0b69d`
- 历史实现提交：`fix(poc4): stop stale terminal socket creation`
- 矩阵工作目录：`poc4/frontend`
- 包管理器：pnpm `10.33.0`；browser commands 设置 `PLAYWRIGHT_HTML_OPEN=never`
- 权威时间源：`.superpowers/sdd/2026-08-25-ensoai-stage-5-active-job-terminal-implementation-plan/matrix-09ded26-summary.json`；逐命令日志位于相邻 `matrix-09ded26-logs/`
- 上述 `.superpowers` 矩阵日志与构建/测试缓存均为本地过程产物，已在合并前按用户要求清理；本报告保留已采集的摘要、计数和限制，不把这些缓存作为交付文件。
- 下方完整绿色矩阵、final production rebuild 与 production scan 绑定历史 `09ded26`；`0c28ad7` 的最新矩阵结果及限制以本报告 Decision 段和 `matrix-0c28ad7-summary.json` 为准
- 历史矩阵后的 49 张、最新矩阵后的 46 张 tracked PNG 均已精确恢复；README 未修改
- EnsoAI 浏览器显示参考保持 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；Stage 5 production 未复制 Electron IPC、`node-pty`、本机路径或旧 PTY 复用语义

本报告只证明 **mock contract verified / real-browser + MSW/mock evidence**。它不证明真实 Spring Boot、MySQL、Fabric8、Kubernetes PTY、Maven app container、reverse proxy 或 cluster 行为；mock session、echo 和 structured audit 均不得称为真实系统证据。

## Historical Complete Matrix

以下 11 条命令是 `09ded26` 历史完整绿色矩阵，全部 exit 0。它证明主体实现曾在同一 immutable SHA 全绿，但不替代 Decision 段披露的 `0c28ad7` 最新 9/11 矩阵。Start/end 是 summary 中的本机时区 wall-clock timestamp，duration 是 wrapper 记录值；mock/E2E 覆盖 `dist` 后另行执行 final production rebuild 和 scan。

| Command | Start -> end | Duration | Exit | Exact result |
|---|---|---:|---:|---|
| `pnpm test:boundary` | `2026-08-25T23:04:55.885+08:00` -> `2026-08-25T23:04:56.897+08:00` | 1.009 s | 0 | node:test **24 pass / 0 fail / 0 skipped**；scanner PASS |
| `pnpm typecheck` | `2026-08-25T23:04:56.933+08:00` -> `2026-08-25T23:05:03.118+08:00` | 6.184 s | 0 | `tsc -b --pretty false` 无诊断 |
| `pnpm test` | `2026-08-25T23:05:03.126+08:00` -> `2026-08-25T23:06:03.976+08:00` | 60.851 s | 0 | Vitest **61 files / 1,123 pass / 0 fail** |
| `pnpm build` | `2026-08-25T23:06:03.982+08:00` -> `2026-08-25T23:06:58.034+08:00` | 54.052 s | 0 | production，**3,787 modules**；保留既有 >500 kB warning |
| `pnpm build:mock` | `2026-08-25T23:06:58.037+08:00` -> `2026-08-25T23:07:56.248+08:00` | 58.210 s | 0 | mock，**3,799 modules**；mock-only `stage0.html` 仅存在于该临时产物 |
| `pnpm test:e2e` | `2026-08-25T23:07:56.252+08:00` -> `2026-08-25T23:10:30.945+08:00` | 154.693 s | 0 | Chromium **66 passed / 18 skipped / 0 failed**；两个 required fixme 各 skip 1 次 |
| `pnpm test:e2e:channels` | `2026-08-25T23:10:30.952+08:00` -> `2026-08-25T23:17:33.604+08:00` | 422.654 s | 0 | Chrome + Edge **164 passed / 4 skipped / 0 failed**；4 skips 为两个 required fixme 各跨两浏览器一次 |
| `pnpm test:e2e:large-files` | `2026-08-25T23:17:33.610+08:00` -> `2026-08-25T23:19:01.856+08:00` | 88.247 s | 0 | **2/2 passed**；20 MiB - 1 Java 与 20 MiB + 1 Markdown |
| `pnpm test:e2e:large-writes` | `2026-08-25T23:19:01.863+08:00` -> `2026-08-25T23:20:33.109+08:00` | 91.246 s | 0 | **1/1 passed**；20 MiB + 1 Markdown PUT |
| `pnpm test:e2e:large-logs` | `2026-08-25T23:20:33.114+08:00` -> `2026-08-25T23:22:15.632+08:00` | 102.518 s | 0 | **1/1 passed**；6,291,522 generated / 5,242,880 retained / 1,048,642 evicted bytes；console/page errors 0/0 |
| `pnpm test:e2e:terminal-stress` | `2026-08-25T23:22:15.642+08:00` -> `2026-08-25T23:23:54.326+08:00` | 98.684 s | 0 | **1/1 passed**；完整 flow/resize/render metrics |

两个 required fixme 在矩阵前后均未 targeted 重试。18/4 的总 skipped 集合还包含 browser project 设计跳过的截图用例；Gate 11/16 的 required 部分精确为 Chromium 各一次、Chrome/Edge 各两次。

## Execution Recovery And Final Review History

- 历史 preflight 曾因 checkout 残留 mock `dist` 失败；production preflight rebuild 恢复了 boundary baseline。该 preflight 不是产品 gate failure，也不是上表 formal matrix。
- 历史 WorkbenchShell time fixture 进入 strict Run response parser（`parseRunSummary`）后因 timestamp 倒序 fail closed；`a1a2772b13d7cc565169aac2fa932bbb9e176d61` 只修复该旧 fixture，不是当前 evidence source。
- 第二次最终审查发现 ticket close code、heartbeat/pause、overflow、Close grace、disconnect 时点、xterm options、create-session error mapping 七组缺口，均已在前一生命周期修复波次中以 TDD 验证。
- Final scoped re-review 随后发现 `connecting` observer reentrant Close 的 stale socket residual；`09ded26` 以两个真实行为回归用例完成修复：connecting 通知同步 close 阻止 factory，factory 内同步 close 后返回的 unowned socket 立即 exception-safe close，且不绑定 listener、不产生二次通知，later events inert。
- controller 随后从 `09ded26` immutable source 执行完整 11 命令矩阵、final production rebuild、scan 与 hygiene；下方历史计数只使用该 source。
- `0b46bad` 至 `0c28ad7` 后续修复了 lazy xterm CSS 边界、ready observer 重入、50 ms input drain，以及 production terminal asset resolver 的 missing/ambiguous/basename-collision false-green。最终 scoped re-review 未发现 Critical/Important，保留 Decision 段所列 1 个 Minor。

## Production Rebuild And Scan

E2E 后 final production `pnpm build`：`2026-08-25T23:24:34.235+08:00` -> `2026-08-25T23:25:45.804+08:00`，71.565 s，exit 0，3,787 modules。final `pnpm test:boundary`：`2026-08-25T23:25:55.224+08:00` -> `2026-08-25T23:25:56.515+08:00`，1.285 s，exit 0，24/24。

Final production `dist` 共 **192 files / 97 text files**。Stage 0-5 累积 34 个 needles（旧 33 + `ticket-unavailable`）逐项 `MATCH_FILES=0`，总计 `FORBIDDEN_MATCH_COUNT=0`；`stage0.html`、MSW worker、MSW/echo 命名文件均为 0。

| Production artifact | Evidence |
|---|---|
| `dist/assets/index-CyzUmOUC.js` | 388,416 bytes；`xterm` literal 0 |
| `dist/assets/WorkbenchPage-Ckwnz9DX.js` | 4,014,286 bytes；`xterm` literal 0；terminal reference 2 |
| `dist/assets/JobTerminalPanel-BZQXZHVC.js` | dedicated lazy terminal JS，664,803 bytes；`xterm` literal 162 |
| `dist/assets/index-CUPLLfWc.css` | 43,938 bytes；`.xterm` selector 109 |

16 个 production terminal files（tests excluded）针对 14 个 patterns：`src/terminal`、`src/spike`、`src/mocks`、`echo-ws`、`electron`、`node-pty`、`pvcName`、`podName`、`jobName`、`namespace`、`serviceAccount`、`dangerouslySetInnerHTML`、`tokeniz`、`appendTerminalAudit`，结果全部为 0。

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

- Request exact keys 只有 `cols` / `rows`，不含 command、shell、cwd、env、container、image 或 resource；API coverage 验证 scoped path encoding、Bearer 与 AbortSignal。
- mock ticket TTL 30,000 ms；replay tombstone bounded lifetime 35,000 ms。HTTP reservation 不创建 live exec；成功 WebSocket handshake 原子 consume ticket 后才创建 live session、RUNNING audit，并发送 `terminal.ready`。
- WebSocket 固定为 `ws(s)://<same-origin>/api/v1/ws/terminals?ticket=<redacted-ticket>`；query 只有 ticket，JWT 不进入 URL、frame 或 DOM；ticket 单次使用，重复连接以 `4409` 关闭。
- missing、unknown、cleaned ticket 以及 missing/duplicate/extra/invalid query shape 统一以 `4410` session-unavailable 关闭，不触发 logout；`4401` 仅保留给 backend 明确判定的 unauthenticated，且仍受 current-token guard 约束。
- `ticket-unavailable` browser case 证明合法 HTTP 201 reservation 在 handshake 时不可用会保留当前 Alice login/workbench，不显示 expired-session alert，且不自动重连。
- ready generation 启动精确 30,000 ms application heartbeat watchdog；只有合法 current-generation `terminal.ping` 会 reset。expiry 作为 connection loss 结束 terminal generation，不改变 Run authority；close/error/dispose/replacement 清 timer，stale callback 惰性。
- server pause state 显式跟踪；duplicate pause 或没有 prior pause 的 resume 都 protocol fail closed。合法 pause/resume 继续驱动 bounded input pump 与 `disableStdin`。
- 正常非重入的 User-confirmed Close 会立即禁用输入、只发送一次 `terminal.close` 并进入 closing；精确 2,000 ms grace 内等待 server exit/socket close，deadline 后 force close/dispose。Run-left、logout、project switch、page disposal/persisted pagehide 与其他 authority teardown 强制立即清理，不等待 grace。
- bounded input overflow 以独立 `input-overflow` 原因关闭 generation，UI 明确说明 session closed 且 part of input may already have been sent；不声称回滚已发送前缀。
- `disconnect` fixture 在 consume ticket、创建 live session/audit、发送 `terminal.ready` 并完成 resize+credit initialization 后才突然 1011 断开；audit settle 为 `INTERRUPTED`。旧 generation 惰性，Run 仍 RUNNING 时后续 explicit Open 使用 fresh sessionId/ticket/socket/xterm。
- create-session `TERMINAL_NOT_AVAILABLE` 保留独立 UI failure，触发一次 active Run authority invalidation/refetch，不自动 retry mutation；`TERMINAL_SESSION_ALREADY_ACTIVE` 使用独立安全提示，要求旧 session 结束后 explicit retry。其他错误保持 generic，server message/reason/trace 不进入 UI。
- Panel switch 保持同一 socket/xterm/session；disconnect、project navigation、logout、current-token 401、shell exit、Run 离开 RUNNING 均禁用输入并清理，不自动 reconnect。

## Bytes, Flow, Resize And Render Evidence

- `onData` sample `stage5-unicode-终端-😀-needle` 为 27 UTF-16 chars / **33 UTF-8 bytes**；browser binary sent/received 长度和前 32 bytes 一致。`onBinary` unit sample `00 1b ff 34 3d 00` 验证 low 8-bit bytes；browser xterm mouse frame 以 `1b 5b 4d` 开头并含 `>0x7f` byte。
- output initial credit 262,144；frame `<=32,768`；只在 xterm `write(..., callback)` 完成后发送 exact FIFO ack。未 ack outstanding 上限 262,144，错误/乱序/重复 ack fail closed。
- input frame `<=16,384`，FIFO cap 1 MiB，`bufferedAmount` high/low watermarks 262,144 / 65,536；pause 时禁输入。overflow 使用独立 `Input queue overflow` 告警，明确 session closed 且 part of input may already have been sent，不声称 rollback 已发送前缀。
- xterm browser options 为 14 px、`scrollback: 5000`、`convertEol: false`；`prefers-reduced-motion: reduce` 匹配时 cursor blink disabled，否则 enabled。固定 theme、monospace stack、bar cursor、initial disabled input 与 Fit/Search/WebGL lifecycle 保持。
- terminal stress fresh metrics：generated / delivered / acked **8,388,650 / 8,388,650 / 8,388,650**；outstanding 0；max outstanding 262,144；max output frame 32,768；input queued / sent 131,085 / 131,085；max input frame 16,384；max buffered 307,200；resize observed / sent **204 / 102**；pause / resume 1 / 1；final marker 1；renderer WebGL；responsiveness 12 ms；console / page errors 0 / 0。
- large-log fresh metrics：6,291,522 generated；5,242,880 retained；1,048,642 evicted；console / page errors 0 / 0。
- WebGL creation failure 与 context loss 均 dispose addon 并回退 DOM renderer；Search、focus、scrollback、clear display 和 resize 在 fallback 下仍可用。每个新 session 创建 fresh Terminal/Fit/Search/WebGL/ResizeObserver resources。

这些指标是本机 real-browser + MSW/mock transport 测量，不是 proxy/backend/cluster SLA，也不证明真实 Kubernetes PTY byte fidelity。

## Audit And Channel Isolation Evidence

```http
GET /api/v1/projects/<project>/runs/<run>/terminal-audits?limit=50&cursor=<redacted-cursor>
Authorization: Bearer <redacted-token>
```

- Audit response 经过 strict parser：`id`、`sessionId`、`command`、`state`、`startedAt`、`finishedAt`、`exitCode` exact keys；state 仅 RUNNING/SUCCEEDED/FAILED/INTERRUPTED，timestamp/state/exitCode 组合一致，ID 唯一、startedAt 降序、nextCursor opaque。
- Browser 验证 50-record first page 与 Load more opaque cursor；mock state覆盖 owner/project/run/session filtering、pagination 与四种 settlement。
- 前端只 query/cache/render backend structured audit；production scan 不含 frontend command tokenizer 或 audit append。hostile command 以 bounded plain text 显示，不使用 `dangerouslySetInnerHTML`。
- Browser markers pairwise isolated：PTY marker 不进入 Audit/Run log，Audit marker 不进入 PTY，Run-log marker 不进入 PTY；stress final marker 在 Run log 为 0。

mock structured audit 只验证展示与查询 contract，不证明真实 Shell/wrapper command boundary、multiline/interactive/signal attribution 或 MySQL persistence。

## Browser And Visual Evidence

- Chromium：66 passed / 18 skipped；新增 executable coverage 包含 ticket-unavailable 保留 login，以及 post-initialize disconnect -> `INTERRUPTED` -> fresh explicit Open。
- 历史 `09ded26` Chrome + Edge：164 passed / 4 skipped；两个 required fixme 各在两个 channel skip 一次，其余 executable cases 通过。最新 `0c28ad7` channel matrix 的 4 个失败按 Decision 段单独披露。
- Chrome/Edge 各验证 Terminal 与 Audit 的 `1280x720`、`1440x900`、`1920x1080`，共 12 张 Stage 5 visual evidence。几何、overflow、xterm nonblank pixels、Search overlay 与 Audit scroll/header assertions 通过。
- 矩阵运行后 tracked diff 精确出现 49 张 PNG 且无其他文件；49 张均恢复到 immutable source SHA，当前没有 tracked PNG diff。

Visual/core PASS 不替代两个 required skipped workflows；Gate 11 与 Gate 16 仅因用户明确豁免而记为 `WAIVED_BY_USER`。

## Real-System Evidence Still Deferred

以下均未验证，本阶段不得作 production conclusion：

1. 真实 Spring Boot JWT 签名以及 owner/project/run/session/ticket backend authorization 与 stale-token race。
2. Fabric8 PTY exec 精确进入当前 Maven Job 的 application container，而不是 sidecar、workspace Pod 或错误 container。
3. browser/pagehide/proxy disconnect 后真实 exec、shell 和 child processes 的 destruction，以及旧 session 不可复用。
4. Run STOPPING/RECOVERING/terminal state 与真实 terminal close、Kubernetes exec 结束、workspace reload 的 race ordering。
5. >=8 MiB flow、credit/ack、input backpressure、watchdog 与 pause/resume 跨真实 proxy/backend/Fabric8/cluster 的行为和 SLA。
6. 真实 Shell/wrapper command-boundary integration，包括 backspace、completion、multiline、interactive programs、signals 与 exit attribution。
7. MySQL audit transaction、owner query、pagination、retention、restart recovery 与 sensitive-command policy。
8. Terminal 对 RWX PVC 的 side effect、cross-node visibility、UID/GID/`fsGroup` 与 Run 后 file reload。
9. 完整 backend restart、proxy reset、cluster reschedule、cross-node 与 cold-start E2E。
10. Kubernetes API/RBAC、container identity、network policy、resource limit 与受控测试 cluster 之外的 security boundary。

## Acceptance Traceability

| POC4 rule | Stage 5 proof | Still deferred |
|---|---|---|
| Only active Maven Job terminal | authority + mock handler state checks | Real target container selection |
| Ticket instead of JWT URL | HTTP ticket + fixed same-origin WS；4410/4401 boundary | Real backend handshake/auth |
| Input/output/resize | binary/control protocol + browser E2E | Real Kubernetes PTY fidelity |
| Disconnect destroys old session | post-initialize mock destroy + INTERRUPTED + fresh IDs | Real exec/process destruction |
| Run end prevents input | authority force close before reload | Real backend Run/PTY race |
| New session on same active Run | explicit Open after closed/restored page | Real exec recreation |
| Command audit | structured query/display + no frontend parser | Real Shell/wrapper + MySQL audit |
| Terminal output separate from logs | store/import/marker isolation | Real backend channel routing |
| Continuous output | 8,388,650-byte browser/mock stress | Proxy/backend/cluster SLA |
| Browser boundary | source/dist/chunk scans | Full real-system threat validation |

## Repository Hygiene

以下全量 encoding/line-ending 计数绑定历史 `09ded26` hygiene scan。按用户要求，本次收尾不再运行新的全量验证扫描；只恢复 46 张已知矩阵 PNG，并修改本结果文件。

- Fresh tracked set：`git ls-files -- poc4/frontend poc4/docs` 共 **291 files**；仅排除 binary `.png` **66 files**，纳入 **225 files**，其中明确包含 `poc4/frontend/.env.mock`。
- Strict UTF-8 decode：**225 valid / 0 invalid**；UTF-8 BOM **0**。
- Line-ending file classification：**189 CRLF-only / 21 LF-only / 15 mixed / 0 CR-only / 0 no-EOL**。
- Line-ending sequence totals：**58,468 CRLF / 9,491 bare LF / 0 bare CR**。
- 历史 `result.md`：UTF-8 without BOM、LF-only；本次收尾使用 `apply_patch` 编辑，未执行 fresh 全量重扫。
- 扫描排除 generated/ignored `dist`、Playwright `test-results`、traces/videos/reports、`.grok`、linked worktrees 与其他 untracked artifacts；它们不纳入 tracked hygiene 或提交。
- 本次 tracked diff 只允许 `poc4/docs/evidence/stage-5/result.md`；README、PNG、source、tests、package/lock、两个 fixme 与 `.grok` 均不修改。

## Exit Gates

| Gate | Status | Fresh evidence and limit |
|---:|---|---|
| 1 | PASS | 历史 immutable matrix：36 contract tests + 24/24 boundary + full unit matrix 61 files / 1,123 tests；最新矩阵的 unrelated dynamic-import hook timeout 作为 verification exception 保留在 Decision 段 |
| 2 | PASS | exact `{cols,rows}` POST；only same-project active RUNNING enables create；无 shell/cwd/env/container/image/resource fields |
| 3 | PASS | mock authority：owner、project availability、current active RUNNING、runId、history/non-RUNNING rejection 与 one-live enforcement |
| 4 | PASS | Bearer HTTP、30 s single-use ticket、same-origin ticket-only WS、JWT absent from URL/frame/DOM；unknown/invalid ticket -> 4410 且保留 login，4401 仅明确 unauthenticated |
| 5 | PASS | unused reservation 不创建 exec；atomic handshake 才创建 one live session/audit 并发出 `terminal.ready`；second live rejected |
| 6 | PASS | 33-byte Unicode、low-byte `onBinary`、xterm mouse bytes、binary direction 与 Run-log isolation |
| 7 | PASS | output frame <=32 KiB、credit 256 KiB、write-callback exact FIFO ack、8,388,650-byte conservation 与 fail-closed checks |
| 8 | PASS | input frame <=16 KiB、queue 1 MiB、256/64 KiB watermarks、strict pause/resume；overflow 明确 session closed 与可能已发送前缀 |
| 9 | PASS | positive/deduped/coalesced resize、inactive/zero gate、reactivation refit；full stress 204 observed / 102 sent |
| 10 | PASS | per-session xterm/addons；14 px、5000 scrollback、no EOL conversion、reduced-motion blink policy；WebGL/DOM fallback、Search/focus/clear/resize lifecycle |
| 11 | **WAIVED_BY_USER** | ticket-unavailable/current 401/pagehide/project/logout/Run-left executable cases pass；required stale Alice terminal 401 preserving newer Bob remains `test.fixme`，未运行、未修改、无 fresh browser PASS |
| 12 | PASS | post-`terminal.ready` + post-initialize disconnect settles INTERRUPTED without reconnect；later explicit Open uses fresh session/ticket/socket/xterm，old generation inert；connect reentrancy 已由 `09ded26` 独立 targeted 覆盖 |
| 13 | PASS | null-active synchronously revokes terminal authority before detail await；pending/rejected/nonterminal do not restore it；fresh RUNNING invalidates stale confirmation；STOPPING close-before-reload passes |
| 14 | PASS | backend-only structured audit、owner/session cursor pagination、safe plain rendering、no frontend parser、PTY/Audit/Run-log isolation |
| 15 | PASS | latest `pnpm test:e2e:terminal-stress` exit 0；8,388,650 generated=delivered=acked、204/102 resize、marker once、28 ms responsive、zero console/page errors |
| 16 | **WAIVED_BY_USER** | Chromium executable core passes；required complete keyboard-only workflow remains `test.fixme`，且 latest Chrome/Edge channel run 有 Decision 段披露的 4 个 timing failures；均无 fresh all-channel PASS |
| 17 | PASS | historical final production scan 34 needles zero；latest production build 3,789 modules、boundary 36/36、asset resolver direct 31/31 + subprocess 5/5，dedicated lazy terminal JS + exact xterm CSS resolution verified |

## Known Risks Carried Forward

- 真实 Kubernetes PTY、disconnect process destruction、container selection 与 Run race 仍是最大 evidence gap。
- Native WebSocket 无 built-in backpressure；browser credit/ack 不能证明真实 proxy/backend 遵守协议。
- xterm beta versions 已锁定但 API 仍可能 drift；本阶段不升级。
- Terminal 可修改 PVC；这是受控测试 cluster risk，不提供 immutable run。
- command audit attribution、input prefix-on-overflow、browser background throttling、watchdog 与 session/Run races 必须在真实系统重新验证。
- `09ded26` 已修复 connecting observer reentrant Close 的 stale socket creation/ownership residual；targeted regression 2/2 GREEN，later events inert，且未改变正常 connect/ready、Close grace、authority teardown 或其他 lifecycle contract。
- required stale-401 ownership race 与完整 keyboard-only workflow 缺少 browser PASS；其状态是用户豁免而非技术 PASS，Stage 6 计划必须继续携带该事实。
- 最新矩阵仍有 1 个 unit hook timeout 与 4 个 Chrome/Edge timing failures；用户要求不再重跑，本报告不将这些 verification exceptions 描述为已修复。
