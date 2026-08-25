# EnsoAI Stage 5 Active Job Terminal Result

## Decision

**STAGE_5_REMEDIATION_REQUIRED**

17 项退出门中 **15 PASS / 2 FAIL**。失败门：

1. **Gate 11 FAIL**：`a stale Alice terminal 401 cannot clear a newer Bob login` 在 Chromium、Chrome、Edge 均没有 fresh browser PASS；该 required case 在四次失败尝试后保持 `test.fixme`，本轮未重试。
2. **Gate 16 FAIL**：完整 keyboard-only File -> Run -> Terminal -> Open -> xterm -> Search -> Audit -> Close workflow 在 Chromium、Chrome、Edge 均没有 fresh browser PASS；该 required case在四次失败尝试后保持 `test.fixme`，本轮未重试。

不得放行或启动 Stage 6。退出码为 0 的 E2E 命令不能把 required skip 解释为 PASS。

## Source And Scope

- 日期：`2026-08-25`（Asia/Shanghai）
- 分支：`codex/poc4-stage-5-active-job-terminal`
- immutable source SHA：`4f0f7ed94edc87c7750a8f6e9d3e05793c09f88d`
- 矩阵工作目录：`poc4/frontend`
- 包管理器：pnpm `10.33.0`；所有浏览器命令均设置 `PLAYWRIGHT_HTML_OPEN=never`
- 本报告是该 SHA 之后的纯文档提交，不修改应用源码、Task 10 PNG 或 README
- EnsoAI 浏览器显示参考仍为 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；生产 Stage 5 未复制 Electron IPC、`node-pty`、本机路径或旧 PTY 复用语义

本报告只证明 **real browser + MSW/mock contract evidence**。它不是 Spring Boot、MySQL、Kubernetes、Fabric8 `pods/exec`、Maven app container、代理或集群证据，任何 mock session/echo/audit 都不得称为真实 Kubernetes PTY。

## Complete Matrix

下表按 brief 顺序串行执行。时间是本机 ISO-8601 起止时间；duration 是命令墙钟。mock/E2E 覆盖 `dist` 后另有 production rebuild 和 scan。

| Command | Start -> end | Duration | Exit | Exact result |
|---|---|---:|---:|---|
| `pnpm test:boundary` | `14:18:46.746+08:00` -> `14:18:47.813+08:00` | 1.063 s | 0 | node:test **24 pass / 0 fail / 0 skipped**；scanner PASS |
| `pnpm typecheck` | `14:18:54.536+08:00` -> `14:19:00.635+08:00` | 6.096 s | 0 | `tsc -b --pretty false` 无诊断 |
| `pnpm test` | `14:20:29.709+08:00` -> `14:21:25.072+08:00` | 55.357 s | 0 | Vitest **60 files / 1,094 pass / 0 fail**；Vitest duration 53.61 s；stderr 仅既有 jsdom canvas-not-implemented 诊断 |
| `pnpm build` | `14:21:41.040+08:00` -> `14:22:33.659+08:00` | 52.615 s | 0 | production，**3,787 modules**，Vite build 45.26 s；保留 >500 kB warning |
| `pnpm build:mock` | `14:22:42.779+08:00` -> `14:23:35.622+08:00` | 52.840 s | 0 | mock，**3,799 modules**，Vite build 45.45 s；包含 mock-only `stage0.html` |
| `pnpm test:e2e` | `14:23:43.482+08:00` -> `14:26:25.104+08:00` | 161.618 s | **1** | Chromium **63 pass / 18 skipped / 1 fail**。唯一 failure 是既有 Stage 3 delayed-first-snapshot-save case 在登录 UI 出现前 timeout；18 skips 含两个 required Stage 5 fixme |
| `pnpm test:e2e:channels` | `14:30:39.851+08:00` -> `14:35:54.238+08:00` | 314.383 s | 0 | Chrome + Edge **160 pass / 4 skipped / 0 fail**；4 skips 精确为两个 required fixme 各跨两浏览器一次 |
| `pnpm test:e2e:large-files` | `14:36:07.896+08:00` -> `14:37:09.322+08:00` | 61.422 s | 0 | **2 pass**；20 MiB - 1 Java 与 20 MiB + 1 Markdown |
| `pnpm test:e2e:large-writes` | `14:37:17.293+08:00` -> `14:38:20.833+08:00` | 63.536 s | 0 | **1 pass**；20 MiB + 1 Markdown PUT |
| `pnpm test:e2e:large-logs` | `14:38:28.643+08:00` -> `14:39:43.968+08:00` | 75.321 s | 0 | **1 pass**；6,291,522 generated / 5,242,880 retained / 1,048,642 evicted bytes |
| `pnpm test:e2e:terminal-stress` | `14:39:53.490+08:00` -> `14:41:40.681+08:00` | 107.187 s | **1** | **1 fail**；30 s 时 `resizeSent=99`，要求 `>=100`；在 final marker/metrics assertion 前停止 |

矩阵整体是 **9 commands exit 0 / 2 commands exit 1**，不能描述为全绿。两个非-fixme failure 均未触发实现修改：

- Stage 3 delayed-save case 的错误上下文显示 `Username` 和 login request 均未出现，失败在业务断言之前。一次 targeted 复证 `14:29:23.899` -> `14:30:19.931`，exit 0，**1/1 pass**（56.029 s；test body 2.0 s）。原 full command 仍记 FAIL。
- stress 循环恰好请求 100 次 viewport change，首轮出现 99 个 coalesced sends。一次 targeted 复证 `14:42:25.508` -> `14:43:40.159`，exit 0，**1/1 pass**（74.647 s）。原 full command 仍记 FAIL，门槛未降低。

执行期间曾在 worktree 根目录误调用一次 `pnpm test:boundary`，因没有 `package.json` 在 1.022 s 内以 exit 1 结束，未启动测试或修改源码；随后从 brief 对应的 `poc4/frontend` 目录开始上述可审计矩阵。第一次 `pnpm test` 的长输出尾部会话丢失，因此完整重跑并只采用表中第二次的新鲜结束块。矩阵之后服务过载导致任务上下文恢复；恢复时没有残留 Playwright/Vite 产品进程，后续从已完成命令检查点继续。

## Production Rebuild And Scan

E2E 后先恢复其重拍的 **44 个已跟踪 PNG** 到 source SHA；Stage 5 PNG diff 为 0。随后执行 production `pnpm build`：`14:44:09.505` -> `14:44:56.085`，46.576 s，exit 0，3,787 modules，Vite build 40.09 s。最终 `pnpm test:boundary`：`14:45:13.403` -> `14:45:14.345`，0.938 s，exit 0，24/24。

production `dist` 共 192 files。逐文件扫描 Stage 0-5 累积 33 个 needles，包括 mock credentials/worker、expire/large-file/write/run/terminal scenario endpoints、Stage 4 ticket/persist/log markers、Stage 5 ticket/session/audit/stress/persist markers、`stage0.html`、echo URL、Electron 和 `node-pty`：每一项 `MATCH_FILES=0`，总计 `FORBIDDEN_MATCH_COUNT=0`。`stage0.html`、`mockServiceWorker*`、MSW/echo 命名文件均不存在。

| Production artifact | Evidence |
|---|---|
| `dist/assets/index-DGQlj-K6.js` | 388,416 bytes；`xterm` literal 0；只动态加载 Workbench |
| `dist/assets/WorkbenchPage-0XoIDV5-.js` | 4,014,199 bytes；`xterm` literal 0；动态引用 `JobTerminalPanel-CRFZtKfP.js` |
| `dist/assets/JobTerminalPanel-CRFZtKfP.js` | dedicated lazy terminal JS，659,145 bytes；xterm code only here（162 literal hits） |
| `dist/assets/index-CUPLLfWc.css` | 43,938 bytes；109 `.xterm` selectors；production xterm CSS exists |

16 个 production terminal source files（tests excluded）另行扫描：`src/terminal`、`src/spike`、`src/mocks`、echo、Electron、Node/`node-pty`、`pvcName`、`podName`、`jobName`、`namespace`、`serviceAccount`、`dangerouslySetInnerHTML`、frontend audit append/tokenizer 均为 0。

## Session, Ticket And Lifecycle Evidence

以下值全部 redacted，禁止从报告恢复 token/ticket/session：

```http
POST /api/v1/projects/<project>/runs/<run>/terminal-sessions
Authorization: Bearer <redacted>
Content-Type: application/json

{"cols":<integer 2..500>,"rows":<integer 1..200>}

HTTP/1.1 201
{"sessionId":"<redacted>","ticket":"<redacted>","expiresAt":"<future ISO-8601>"}
```

- Request exact keys只有 `cols` / `rows`；无 command/shell/cwd/env/container/image/resource。API unit test还证明 scoped path 编码、Bearer header 和 AbortSignal。
- mock ticket TTL 精确 `30,000 ms`，replay tombstone/grace `5,000 ms`。HTTP reservation 不创建 live exec；成功 WebSocket handshake 原子 consume 一次后才创建 live session、RUNNING audit 并发 `terminal.ready`。过期 unused reservation 只清 reservation。
- WebSocket 固定为 `ws(s)://<same-origin>/api/v1/ws/terminals?ticket=<redacted>`；query 只有 ticket，JWT 不进 URL/frame/DOM。重复使用 ticket 的浏览器连接 close code 为 `4409`。
- 两个独立 unused reservations 可存在；第一个成功 consume 后，第二个 live consume 和新 HTTP reservation都因 one-live rule 被拒绝。close/disconnect 会清 live 并撤销 stale reservation；同一 RUNNING Run 再显式 Open 会得到全新的 session ID、ticket 和 xterm generation。
- Browser lifecycle 覆盖 explicit close（Cancel/Escape/Confirm）、abnormal disconnect 无 reconnect、project navigation、logout、current-token 401、shell exit、Run 离开 RUNNING。Run STOPPING 事件实测 `terminal socket closeAt <= workspace reload fetchAt`，且历史 Run 不能 Open。
- Controller generation 在 teardown 先禁用输入、关闭 transport、dispose xterm，再使旧 callbacks/ticket 无效并 invalidate audit。`WorkspaceResourceRegistry` 统一注册 connection close 和 workspace disposal；pagehide/unmount 清理幂等。
- **缺口**：stale Alice terminal 401 在 Bob 新登录后不清 Bob 的浏览器 ownership gate 没有 fresh PASS，因此 Gate 11 FAIL；unit coverage不能替代 required browser evidence。

## Bytes, Flow, Resize And Render Evidence

- `onData` UTF-8 sample `stage5-unicode-终端-😀-needle` 是 27 UTF-16 chars / **33 UTF-8 bytes**；浏览器 sent/received binary frames 的长度和前 32 bytes 相同。`onBinary` unit sample `00 1b ff 34 3d 00` 证明每个 code unit 只取低 8 bit；真实 xterm mouse frame 以 `1b 5b 4d` 开头并包含 `>0x7f` byte。
- output control：initial `terminal.output.credit=262,144`；server binary frame `<=32,768`；只有 xterm `write(..., callback)` 完成才发送 exact FIFO `terminal.output.ack`。未 ack outstanding 上限 262,144，错误/乱序/重复 ack fail closed。
- input pump：frame `<=16,384`，FIFO cap 1 MiB，`bufferedAmount` high/low watermarks 262,144 / 65,536；overflow 整个 session fail closed。browser 96 KiB burst 在 forced 307,200 bufferedAmount 时 0 send，恢复后 98,304 bytes 全部发送。
- resize：正整数、dedupe、RAF coalesce；inactive/zero-size 不发，重新显示 refit。full stress 第一次为 99 sends 而 FAIL；一次 targeted fresh run为 **202 observed / 101 sent**，门槛没有调整。
- renderer：WebGL creation failure和 `webglcontextlost` 都 dispose addon 并落到 DOM fallback；fallback 下 resize、Search、Escape focus return 仍通过。每次 session 创建新 Terminal/Fit/Search/WebGL/ResizeObserver/RAF resources，旧 context-loss/RAF/observer/write/input不能影响新 generation。
- targeted real-browser stress metrics：**8,388,650 generated = delivered = acked bytes**；outstanding 0；max outstanding 262,144；max output frame 32,768；input queued = sent 131,085；max input frame 16,384；max buffered 307,200；pause/resume 1/1；final marker 1；renderer WebGL；responsiveness 13 ms；console errors 0；page errors 0；Run log terminal marker 0。

这些数字是本机 real-browser/mock-server 测量，不是 proxy/backend/cluster SLA，也不证明真实 PTY 字节 fidelity。

## Audit And Channel Isolation Evidence

```http
GET /api/v1/projects/<project>/runs/<run>/terminal-audits?limit=50&cursor=<redacted>
Authorization: Bearer <redacted>
```

- Audit response经 strict parser：`id`、`sessionId`、`command`、`state`、`startedAt`、`finishedAt`、`exitCode` exact keys；state 只有 RUNNING/SUCCEEDED/FAILED/INTERRUPTED，timestamp/state/exitCode 组合必须一致，ID 唯一且 startedAt 降序，opaque nextCursor。
- Browser first page为 50 records + header（51 rows），Load more携带 opaque cursor；mock state测试覆盖 owner/project/run/session filtering、newest-first 两页 2+2、states RUNNING/SUCCEEDED/FAILED/INTERRUPTED 和 shell success/failure/disconnect settlement。
- 前端只 query/cache/render backend structured audit；production scan找不到 frontend command tokenizer/audit append。hostile command以 bounded `<code>` plain text呈现，控制字符替换，不使用 `dangerouslySetInnerHTML`。
- Browser marker isolation：PTY `ensoai-stage5-pty-only-marker` 不进入 Audit 或 Run log；Audit `ensoai-stage5-audit-marker` 不进入 PTY；Run log `ensoai-stage4-seed-log` 不进入 PTY；stress final marker在 Run log为 0。

mock structured audit不证明真实 Shell/wrapper command-boundary integration、multiline/interactive/signal attribution或 MySQL persistence。

## Browser And Visual Evidence

Chrome/Edge channel command通过 160 executable cases。Stage 5 branded visual case在两浏览器各验证三个 viewport，生成并验证现有 12 个 Task 10 PNG：Terminal 与 Audit各 `1280x720`、`1440x900`、`1920x1080`；root/body无横向 overflow，toolbar/status/xterm或Audit scroller/header在 viewport内，xterm和整页均有非背景像素，Search overlay geometry受约束。本轮复拍后全部恢复到 source SHA，没有修改/提交 PNG。

这些 visual PASS 不替代 keyboard-only required case。该 case在 Chrome/Edge/Chromium都 skipped，所以 Gate 16 FAIL。

## Real-System Evidence Still Deferred

以下全部未验证，Stage 5 不得对其作生产结论：

1. 真实 Spring Boot JWT签名、owner/project/run/session授权、stale token race和统一 401 lifecycle。
2. Fabric8 PTY exec精确进入当前 Maven Job的应用 container，而不是 sidecar、workspace Pod或错误 container。
3. browser disconnect、pagehide、proxy断开后，真实 exec、shell和child processes确实销毁；旧 session不能存活或复用。
4. Run STOPPING/RECOVERING/终态与真实 terminal close、Kubernetes exec结束、Stage 4 workspace reload之间的竞态顺序。
5. >=8 MiB input/output、credit/ack、`bufferedAmount`和 pause/resume跨真实 reverse proxy、Spring backend、Fabric8和cluster的行为及SLA。
6. 真实 Shell/wrapper command-boundary integration，包括backspace、completion、multiline、interactive program、signals和exit attribution。
7. MySQL audit事务、owner query、pagination、retention、后端重启恢复与敏感命令政策。
8. terminal对 RWX PVC 的真实副作用、跨节点可见性、UID/GID/`fsGroup`和Run后文件reload。
9. 完整 backend restart、proxy reset、cluster reschedule、cross-node和cold-start E2E。
10. Kubernetes API/RBAC、container identity、network policy、resource limits和受控测试集群外的安全边界。

## Repository Hygiene

- tracked `poc4/frontend` + `poc4/docs` text：**222 files** strict UTF-8 decode PASS；UTF-8 BOM **0**。
- checkout `core.autocrlf=true`，repo未提供 `.editorconfig` / `.gitattributes` text policy；现有 tracked text中 **196 files / 55,033 CR bytes**（66,574 LF bytes）为当前 Windows checkout CRLF状态。本次新增 `result.md` 必须 UTF-8无 BOM，并在提交前另验 CR/BOM。
- scan/hygiene排除 `.grok/`、linked worktrees、Playwright `test-results`/traces/videos/reports和生成 `dist`；它们不纳入提交。
- Task 10的12张 Stage 5 PNG及所有Stage 0-4 recapture均未改；README未改。

## Exit Gates

| Gate | Status | Fresh evidence and limit |
|---:|---|---|
| 1 | PASS | 34 contract tests + boundary/unit matrix strict-parse session/audit/control exact keys, IDs, timestamp/state, dimensions, frame size and close/error combinations |
| 2 | PASS | API/browser exact `{cols,rows}` POST，active same-project RUNNING gating，extra shell/cwd/container/resource fields absent |
| 3 | PASS | mock authority tests cover owner、READY、current active RUNNING、runId、history/STARTING/STOPPING bypass和single-live |
| 4 | PASS | Bearer HTTP、30 s single-use bound reservation、same-origin ticket-only WS、JWT not in URL/frame/DOM；secrets redacted here |
| 5 | PASS | unused reservation creates no exec；successful atomic handshake creates one live session/audit before ready；second live rejected |
| 6 | PASS | 33-byte Unicode、low-byte onBinary、real xterm mouse bytes、binary direction和Run-log isolation |
| 7 | PASS | <=32 KiB frames、256 KiB credit、write-callback ack、exact FIFO conservation和timeout/fail-closed tests |
| 8 | PASS | <=16 KiB input frames、1 MiB queue、256/64 KiB watermarks、pause/resume、overflow fail closed、no silent drop |
| 9 | PASS | positive/deduped/coalesced resize、inactive/zero gate、re-show refit；targeted stress fresh 202/101 |
| 10 | PASS | per-session xterm/addons、WebGL creation/context-loss DOM fallback、Search/focus/clear/resize lifecycle |
| 11 | **FAIL** | project/logout/current 401/Run-left cleanup pass，但 stale Alice terminal 401 preserving Bob仍是 required `test.fixme`，无 fresh browser PASS |
| 12 | PASS | explicit Close/disconnect不重连；fresh Open使用new session/ticket/xterm；old generation inert |
| 13 | PASS | STOPPING/RECOVERING先disable/close terminal再reload；terminal exit不改变Run authority或解锁 |
| 14 | PASS | backend-only structured audit、owner/session cursor pages、safe plain rendering、PTY/Audit/Run-log pairwise isolation |
| 15 | PASS | targeted fresh stress满足8,388,650-byte conservation、101 resize sends、marker/response/error gates；但首次full matrix stress的99-send FAIL仍保留在矩阵 |
| 16 | **FAIL** | Chromium/Chrome/Edge其他core与12张visual通过，但required keyboard-only xterm-to-Search/Audit/Close case仍是 `test.fixme` |
| 17 | PASS | final production rebuild + 24/24 boundary；33 needles 0；no stage0/MSW/echo；entry/Workbench xterm 0；lazy terminal JS + xterm CSS |

## Known Risks Carried Forward

- 真实 Kubernetes PTY、disconnect process destruction、container selection和Run race仍是最大证据缺口。
- Native WebSocket没有内建backpressure；browser credit/ack不能证明真实proxy/backend遵守协议。
- xterm beta版本锁定但API仍可能漂移；本阶段不升级。
- Terminal可修改PVC；这是受控测试集群风险，不提供immutable run。
- command audit attribution、input prefix-on-overflow、浏览器后台节流和session/Run竞态必须在真实系统重新验证。
- 本次full Chromium和full stress各有一次非稳定FAIL，即使targeted复证通过，也必须在remediation中消除matrix不稳定，不能把本报告描述为全绿。

最终决定保持：

**STAGE_5_REMEDIATION_REQUIRED**
