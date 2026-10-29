# EnsoAI Stage 5 Active Job Terminal Implementation Plan

> **Execution rule:** Implement task by task in a new isolated worktree created from the accepted Stage 5 plan commit. Use TDD for every behavior change, pnpm for every package operation, small focused patches, and one focused commit per task. Stop at the Stage 6 decision gate; do not implement the real backend, MySQL, Kubernetes PTY bridge, or cluster acceptance from this plan.

**Goal:** 在阶段 4 权威 Run 与日志工作台基础上，交付当前活动 Maven Run 的浏览器终端前端闭环：用户显式创建一次性终端会话，使用短期单次 ticket 建立同源 WebSocket PTY，完成 xterm 输入/输出、resize、搜索、WebGL 降级、流控、主动关闭、断线销毁、新会话和结构化命令审计展示。

**Architecture:** TanStack Query 管理后端 terminal audit 等服务端状态；`JobTerminalController` 管理单个 project/run/session 的短生命周期状态；`JobTerminalTransport` 管理 ticket-bound WebSocket、二进制 PTY 字节和 JSON 控制帧；`XtermTerminalAdapter` 独占 xterm、Fit/Search/WebGL addons 和 dispose。终端不会进入 Zustand，不会复用 Run log transport，也不会持久化输出或旧 session。只有 Stage 4 active authority 明确为 `RUNNING` 时才允许创建。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、TanStack Query 5.101.4、xterm.js `@xterm/xterm` 6.1.0-beta.302、FitAddon 0.12.0-beta.299、SearchAddon 0.17.0-beta.299、WebglAddon 0.20.0-beta.298、MSW 2.15.0 WebSocket API、Vitest、Testing Library、Playwright、Tailwind CSS 4、Lucide React。所有 xterm 包已被 Stage 0 精确锁定，本阶段不新增或升级依赖。

**Current documentation checked on 2026-08-25:** xterm 官方资料确认 `onData` 与 `onBinary` 是两类用户输入，`write(data, callback)`/`onWriteParsed` 是输出解析完成和流控接口，内部约 50 MB discard watermark 不能代替应用流控，FitAddon 使用 `proposeDimensions()`/`fit()`，Terminal/addons 必须 dispose；MSW 官方资料确认 `ws.link()` 可拦截 connection/message/close 并发送/接收 WebSocket 数据；MDN 确认原生 WebSocket 构造只接受 URL/subprotocol、公开 `binaryType`/`bufferedAmount` 且没有内建 backpressure，close reason 最多 123 UTF-8 bytes。生产实现仍必须以锁定的 beta 版本类型声明和行为测试为准。

---

## Scope And Non-Negotiable Boundaries

### Included

- Terminal 工作台面板、显式 `Open terminal`、`Close terminal`、连接/输入暂停/退出/错误状态。
- 只绑定当前 owned project 的权威 active Run，且 Run state 必须为 `RUNNING`。
- `POST terminal-sessions` 获取 opaque `sessionId`、约 30 秒有效的单次 ticket 和 ticket expiry。
- 固定同源 `/api/v1/ws/terminals?ticket=` WebSocket；主 JWT 不进入 URL 或 frame。
- client -> server 二进制 PTY 输入，同时覆盖 xterm `onData` UTF-8 输入和 `onBinary` 原始字节输入。
- server -> client 二进制 PTY 输出，使用显式 credit/ack 与 xterm `write` callback 控制未解析字节。
- JSON 控制帧：ready、resize、close、output credit/ack、input pause/resume、ping/pong、exit、error。
- FitAddon 初始尺寸与 ResizeObserver 合并 resize；隐藏 panel 不发送 0 cols/rows。
- SearchAddon 本地 scrollback 搜索；WebglAddon 加载失败或 context loss 后回退默认 renderer。
- 断线、页面关闭、project switch、logout、当前会话 401、Run 离开 `RUNNING` 时关闭并 dispose；旧 session 不恢复、不自动重连。
- 同一 Run 结束旧 session 后，可由用户显式创建全新的 session/ticket/xterm。
- `GET terminal-audits` 查询后端结构化命令审计，按 session/run 隔离；前端不解析键流。
- mock HTTP/WebSocket、单元/组件测试、Chromium/Chrome/Edge E2E、视觉证据和真实持续终端输出/resize 压力验证。

### Explicitly excluded

- 真实 Spring Boot terminal endpoint、真实 JWT 签名、MySQL audit、Fabric8 exec、Kubernetes PTY 或容器 Shell。
- 真实 app container 选择、Pod/Job/container 名称、Namespace、ServiceAccount、PVC path 或 Kubernetes API 标识。
- workspace Pod Shell、独立于活动 Maven Run 的 Shell、Run 结束后的 Shell、任意容器选择。
- 浏览器提供 shell executable、命令、cwd、环境变量、container、image、TTY user 或资源配置。
- 旧 PTY session 恢复、自动重连、多人共享会话、多 terminal tabs、session persistence 或录屏。
- 从按键流解析命令、将 terminal output 当作 Run log、将 Run log 写入 xterm、审计输出正文。
- 文件链接识别、本机路径打开、复制路径、拖拽、上传、Git/Worktree/Agent、本机 HOME/platform 逻辑。
- 生产级恶意命令隔离、出网策略、审计防篡改、Shell 子进程树强杀证明；它们属于真实系统验收。

### Evidence interpretation

- 本阶段所有 terminal availability、ticket、session uniqueness、PTY 字节、disconnect destroy、flow control 和 audit 结果只能称为 **mock contract verified**。
- MSW/xterm 可以证明浏览器协议、渲染、流控和生命周期，不能证明真实 Kubernetes exec、TTY、进程退出、容器身份、PVC 副作用、命令审计来源或后端销毁旧 exec。
- Stage 5 结束后，真实 Spring Boot/MySQL/Kubernetes/PVC/Run/log/terminal 的一体化证据仍全部属于 Stage 6。
- UI disabled、session ticket、同源 URL 和 client close 不是安全边界；真实后端必须重新校验 owner、project、active run、run state、session、ticket 和 target container。
- 浏览器 contract、DOM、错误、截图、audit 和 WebSocket frame 中不得出现物理资源名称或绝对路径。`runId`/`sessionId`/`auditId` 都是不透明业务 ID。

### Stage 0 reuse boundary

Stage 0 的 `src/terminal/**`、`TerminalPanel.tsx` 和 `scripts/echo-ws.mjs` 仍是独立 Spike 回归产物，不得直接导入生产 Stage 5。允许复用或硬化纯浏览器显示层：xterm theme、`TerminalSearchBar`、Fit/Search/WebGL 使用方式和现有视觉密度。生产协议、transport、session controller、ticket 和 lifecycle 必须在新 Stage 5 模块中实现。

### UI and accessibility guardrails

- 保持 EnsoAI 紧凑 IDE shell 和现有 File/Run 视觉语言。Terminal 是第三个工具面板，不是 full-screen landing、沉浸式产品导览或卡片 dashboard。
- 拒绝 `ui-ux-pro-max` 返回的鲜艳 block layout、大标题、浮动 CTA、hover scale 和移动端营销 fallback；只采用键盘可达、可见 focus、状态反馈和稳定布局原则。
- File、Run、Terminal 在首次加载 Terminal 后一直挂载；inactive panel 使用 `inert`、`aria-hidden`、`invisible` 和 `pointer-events-none`，session 在面板切换时保持。
- Terminal panel 初次选择只加载 xterm chunk，不自动创建后端 session。用户必须点击 `Open terminal`。
- Open、Close、Clear display、Search、Audit 使用 Lucide 图标或标准视图 tabs；icon-only 按钮有 `title`、`aria-label`、固定 32 px 命中框和可见 focus ring。
- Close 会不可恢复地销毁当前 exec，必须确认，默认焦点 Cancel，Escape 等价 Cancel，关闭后恢复触发按钮焦点。
- xterm ready 后显式 focus；打开 Search 后 focus 输入，Escape 关闭 Search 并把 focus 返回 terminal。`Ctrl/Cmd+F` 只在 active Terminal panel 拦截。
- 连接/暂停/退出用文本、图标和 `role="status"`；错误用 `role="alert"`。不能只用颜色区分 input paused 或 disconnected。
- Audit 是 Terminal panel 内的独立 view tab，使用语义表格/列表；命令文本按纯文本呈现，禁止 `dangerouslySetInnerHTML`。
- 1280 px 下 toolbar、xterm viewport、search bar、status 和 audit 无重叠/裁切；字体不随 viewport 缩放；hover 不引发布局位移。

### Stage 5 exit gate

只有以下条件全部满足，Stage 5 才结束：

1. terminal session/audit HTTP 与所有 control frame 都经过严格运行时验证；非法 ID、timestamp、状态、size、cols/rows、close code 或未知组合整包拒绝。
2. Create session 只在 active authority 明确为同 project 的 `RUNNING` 时发送；请求正文只有 `cols`/`rows`，不包含 command/shell/cwd/env/container/image/resource。
3. mock handler 独立验证 owner、READY project、当前 active `RUNNING`、runId 和单活 session；越过 UI 的历史/STARTING/STOPPING/terminal Run 请求被拒绝。
4. ticket 通过 Bearer HTTP 获取、约 30 秒、单次使用、绑定 user/project/run/session；主 JWT 不进入 WebSocket URL/frame/DOM/截图，response 不返回任意 host/path。
5. WebSocket 成功握手前不创建 mock exec；未使用 ticket 到期只清 reservation。第一根成功握手创建 session，后续并发 ticket/连接不能创建第二个 live session。
6. xterm `onData` 和 `onBinary` 均按字节正确送达；Unicode/paste/control bytes 不乱码、不走 JSON、不混入 Run log。
7. server output 使用 <=32 KiB 二进制 chunk、初始 credit 和 `write(..., callback)` ack；未 ack 输出不得超过 256 KiB，不能依赖 xterm 50 MB discard watermark。
8. client input 使用有界 pump 和 `WebSocket.bufferedAmount` 高低水位；pause 时 `disableStdin=true`，不静默丢输入。队列溢出 fail closed 并结束 session，而不是部分继续。
9. Fit/Resize 只发送正整数、去重且合并；初始 ready 后至少一次 resize，panel 隐藏/0 尺寸不发送，重新显示后 refit，resize storm 不淹没 socket。
10. WebGL load failure/context loss 自动 dispose addon 并回退默认 renderer；Search、focus、scrollback、clear display 和 keyboard 行为在 fallback 下仍可用。
11. panel switch 保持同一 socket/xterm/session；用户 Close、socket close/error、pagehide/unmount、project switch、logout/401 或 active Run 离开 `RUNNING` 都立即禁用输入并最终 dispose。
12. abnormal disconnect 不自动重连旧 session；后端 mock 记录旧 session `INTERRUPTED`/closed，用户只有在 Run 仍 `RUNNING` 时显式创建新 session，新的 sessionId/ticket/xterm 不复用旧资源。
13. Run 终态/STOPPING/RECOVERING 先关闭 terminal、禁止输入，再执行 Stage 4 workspace reload；socket close 或 terminal exit 自身不改变 Run authority、不解锁文件。
14. command audit 只来自 mock backend 结构化记录，按 project/run/session owner 查询、cursor 分页；退格/补全/多行/交互程序不由前端推断。audit 与 PTY output/Run log 三者隔离。
15. 真实至少 8 MiB PTY 输出、输入 burst、>=100 次 resize 的 Chromium 压力用例证明最终 marker 唯一、ack/credit 字节守恒、无 xterm discard error、页面响应、Run log 零 terminal marker。
16. Chromium、真实 Chrome、真实 Edge 核心流程通过；1280 px 无重叠/不可达操作，xterm canvas/DOM renderer 非空，键盘可进入 Terminal、Open、xterm、Search、Audit、Close dialog。
17. 生产 build 不包含 Stage 5 scenario endpoint、mock ticket/session/audit marker、echo URL 或 `stage0.html`；入口与 File/Run 初始 chunk 不静态包含 xterm，Terminal 首次选择才懒加载生产 terminal chunk。

## First-Principles State Ownership

| State | Owner | Reason |
|---|---|---|
| active Run / Run authority | Stage 4 TanStack Query + coordinator | terminal availability 的唯一服务器权威来源 |
| terminal audit pages | TanStack Query | 服务端持久化记录，可分页/refetch |
| create-session pending/error | TanStack Mutation | 一次性 HTTP 操作状态 |
| terminal phase/sessionId/inputPaused/exit | `JobTerminalController` | 短生命周期外部资源状态，不持久化 |
| socket/ticket/input pump/output credit/timers | `JobTerminalTransport` | 必须原子 close/dispose，不能进 React state |
| xterm/addons/ResizeObserver/search/focus | `XtermTerminalAdapter` | DOM/GPU 资源，必须显式 dispose |
| panel selection | Workbench shell local state | File/Run/Terminal UI 会话状态 |

禁止把 PTY 字节、xterm buffer、ticket 或 session controller 放入 Zustand/TanStack Query。Audit query 不保存 terminal output。Run log store 和 terminal controller 永不互相导入。

## Terminal HTTP Contract

### Opaque identifiers

```ts
declare const terminalSessionIdBrand: unique symbol;
declare const terminalTicketBrand: unique symbol;
declare const terminalAuditIdBrand: unique symbol;

export type TerminalSessionId = string & {
  readonly [terminalSessionIdBrand]: true;
};
export type TerminalTicket = string & {
  readonly [terminalTicketBrand]: true;
};
export type TerminalAuditId = string & {
  readonly [terminalAuditIdBrand]: true;
};
```

ID/ticket 为非空、最多 256 code units 的 opaque string；前端不解析、不排序、不生成 sessionId。

### Create session

```ts
export type CreateTerminalSessionRequest = {
  cols: number;
  rows: number;
};

export type CreateTerminalSessionResponse = {
  sessionId: TerminalSessionId;
  ticket: TerminalTicket;
  expiresAt: string;
};
```

```text
POST /api/v1/projects/{projectId}/runs/{runId}/terminal-sessions
```

- Body keys 必须精确为 `cols`/`rows`。`cols` 为 2..500、`rows` 为 1..200 的 safe integer。
- Backend 从 URL/JWT 重新确定 project/run/user；body 不允许 `sessionId`、command、shell、cwd、env、container、image 或资源字段。
- HTTP 成功只创建短期 reservation/ticket，不启动 PTY。WebSocket 握手消费 ticket 后才创建 live session。
- 同 user/project/run 只允许一个 live session；unused reservation 可并存但到期清理，第一根成功连接胜出。
- Response 不允许 `url`/`host`/`path`/physical resource fields。

### Audit list

```ts
export type TerminalAuditState =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'INTERRUPTED';

export type TerminalAuditEntry = {
  id: TerminalAuditId;
  sessionId: TerminalSessionId;
  command: string;
  state: TerminalAuditState;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
};

export type TerminalAuditListResponse = {
  items: TerminalAuditEntry[];
  nextCursor: string | null;
};
```

```text
GET /api/v1/projects/{projectId}/runs/{runId}/terminal-audits?limit=50&cursor={opaqueCursor}
```

- command 非空、最多 4096 code units，纯文本显示；不允许 cwd/physical path/container metadata。
- `RUNNING` 要求 finishedAt/exitCode null；其他状态要求 finishedAt，成功 exit 0，失败可 integer，interrupted 可 null。
- timestamps 有序；items 按 startedAt 降序、ID 去重、cursor opaque。
- 前端只查询/展示。真正 command boundary 由容器 Shell integration 或后端 PTY wrapper 产生，Stage 6 才验证。

### API errors

```ts
type Stage5ApiErrorCode =
  | 'TERMINAL_NOT_AVAILABLE'
  | 'TERMINAL_SESSION_ALREADY_ACTIVE'
  | 'TERMINAL_TICKET_NOT_AVAILABLE';
```

- `TERMINAL_NOT_AVAILABLE`：refetch active Run；不能根据错误猜测 container/run 状态。
- `TERMINAL_SESSION_ALREADY_ACTIVE`：不附带可恢复 ticket；提示旧 session 必须结束后显式重试。
- `TERMINAL_TICKET_NOT_AVAILABLE`/network：reservation 尚未产生 live exec；不自动无限重试，用户显式 Retry。
- mutation `retry:false`；401 沿用 current-token cleanup，stale-token 401 不清新用户。

## Terminal WebSocket Protocol

### Fixed URL and handshake

Browser 从当前 `window.location` 只做 `http -> ws`、`https -> wss`，固定构造：

```text
/api/v1/ws/terminals?ticket={encodeURIComponent(ticket)}
```

不接受 response/server 提供任意 WebSocket URL。ticket 在 handshake 被消费。应用 close codes：`4400` protocol、`4401` unauthenticated、`4403` forbidden、`4408` expired、`4409` used、`4410` session unavailable、`1011` retryable server failure。客户端忽略自由文本 reason，不把 reason 当权威状态。

### Binary frames

- client -> server binary：PTY input bytes。
- server -> client binary：PTY output bytes。
- 每个 frame 上限 32 KiB。方向本身区分 input/output；binary payload 内不加自定义 header。
- `socket.binaryType = 'arraybuffer'`；unexpected Blob/string-in-binary-position 触发 protocol failure。

### Client control frames

```ts
export type TerminalClientControl =
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.close' }
  | { type: 'terminal.output.credit'; bytes: number }
  | { type: 'terminal.output.ack'; bytes: number }
  | { type: 'terminal.pong'; nonce: string };
```

### Server control frames

```ts
export type TerminalExitReason =
  | 'SHELL_EXITED'
  | 'RUN_LEFT_RUNNING'
  | 'CLIENT_CLOSED'
  | 'CONNECTION_LOST'
  | 'BACKEND_ERROR';

export type TerminalErrorCode =
  | 'PROTOCOL_ERROR'
  | 'SESSION_NOT_AVAILABLE'
  | 'INPUT_OVERFLOW'
  | 'OUTPUT_FLOW_TIMEOUT'
  | 'PTY_EXEC_FAILED';

export type TerminalServerControl =
  | { type: 'terminal.ready'; sessionId: TerminalSessionId }
  | { type: 'terminal.input.pause' }
  | { type: 'terminal.input.resume' }
  | { type: 'terminal.ping'; nonce: string }
  | {
      type: 'terminal.exit';
      exitCode: number | null;
      reason: TerminalExitReason;
    }
  | {
      type: 'terminal.error';
      code: TerminalErrorCode;
      retryable: false;
    };
```

- `ready.sessionId` 必须等于 HTTP response sessionId，否则关闭。
- ready 后 client 发送 initial resize 和 `terminal.output.credit` 256 KiB。
- nonce 非空且 bounded；pong 只回应当前 generation 的 ping。
- `terminal.error.retryable` 固定 false：旧 PTY session 不可恢复。Run 仍 RUNNING 时 UI 可让用户新建 session。
- Control JSON 严格 keys、frame size <=8 KiB；未知/重复 ready/非法 transition fail closed。

## Flow Control Decisions

### Server output to xterm

1. Client 初始 grant 256 KiB credit。
2. Server 只有 credit 足够时发送 <=32 KiB output frame，并扣减 exact byteLength。
3. Client 按顺序调用 `terminal.write(Uint8Array, callback)`。
4. callback 表示 xterm 已解析该 frame；client 才发送 exact `terminal.output.ack` bytes 补充 credit。
5. outstanding credit 永不超过 256 KiB；ack mismatch/underflow/overflow 是 protocol error。

不得用 `writeSync`。不得一次把 8 MiB 数据塞进 xterm。xterm 约 50 MB discard watermark 只是最后保护，不是验收流控。

### Xterm input to server

- `onData` 使用 `TextEncoder` 得到 UTF-8 bytes；`onBinary` 将每个 code unit 的低 8 bit 转成原始 byte，不能再 UTF-8 编码。
- `TerminalInputPump` 将输入切为 <=16 KiB frames，FIFO 上限 1 MiB。
- socket `bufferedAmount >= 256 KiB` 或 server pause 时停止 drain、设置 `disableStdin=true`；低于 64 KiB 且 server resume 后继续 drain/启用输入。
- 使用 injectable 50 ms drain scheduler；dispose 清 timer/queue。
- 队列将超过 1 MiB 时不静默丢弃；controller 进入 error，关闭 session，显示 `Input queue overflow`。

## Terminal Lifecycle State Machine

```text
UNAVAILABLE (no active RUNNING Run)
  -> AVAILABLE
  -> CREATING_RESERVATION
  -> CONNECTING
  -> READY <-> INPUT_PAUSED
  -> CLOSING
  -> CLOSED | EXITED | ERROR

READY | INPUT_PAUSED
  -- panel switch --> same session remains mounted
  -- Run leaves RUNNING --> input disabled -> CLOSING -> CLOSED
  -- socket disconnect --> INTERRUPTED -> dispose; no reconnect
  -- user Close --> terminal.close -> grace timeout -> dispose

CLOSED | EXITED | ERROR
  -- active Run still RUNNING + explicit Open --> new session/controller resources
```

Rules:

- Availability uses Stage 4 active authority, not selected history detail、Run toolbar text、socket state or cached terminal audit。
- `STARTING/STOPPING/RECOVERING` and all terminal Run states are unavailable。
- CREATING/CONNECTING fail or pagehide before ready destroys reservation by expiry and local resources；no old session recovery。
- User close sends `terminal.close`, disables input immediately, waits at most 2 seconds for exit/close, then closes socket/disposes regardless。
- App-level ping watchdog is 30 seconds；timeout treats connection as lost, disposes and never changes Run state。
- Run leaves RUNNING: backend/mock atomically invalidates unused reservations and closes live sessions；browser terminal close/dispose is initiated before Stage 4 workspace reload may unlock files。

## Xterm Integration Decisions

- Create a new Terminal per successful Open attempt; never reuse disposed Terminal/session/addons。
- Options include fixed theme、14 px font、`scrollback: 5000`、`cursorBlink` subject to reduced-motion preference、`convertEol: false` and `disableStdin` based on controller。
- Load FitAddon and SearchAddon before open。After open, use `proposeDimensions()`; only create HTTP reservation when valid positive dimensions exist。
- Load WebglAddon after open in try/catch。Subscribe `onContextLoss`, dispose only WebglAddon and retain Terminal/Fit/Search/default renderer。
- ResizeObserver + activation signal schedules one fit per animation frame, compares last cols/rows, and sends only changed values while READY/INPUT_PAUSED。
- Inactive Terminal panel remains mounted but does not fit at zero size；reactivation refits and sends resize。
- Search works only against local xterm scrollback。Clear display calls xterm `clear()` only; it does not send `clear` to Shell and does not alter audit/Run logs。
- xterm/addons/observer/listeners dispose in deterministic reverse order even if one disposer throws。

## Command Audit Boundary

Browser keystrokes cannot reliably identify commands because of backspace、history、completion、multiline input、paste and interactive programs。Therefore:

- No production Stage 5 module tokenizes input or appends audit entries。
- Mock server may inject structured audit records to exercise the display contract, but evidence says **mock backend audit fixture**，not command-capture proof。
- Audit polling/refetch occurs while READY at a bounded interval (for example 2 seconds) and once after exit/close；401/403 follow standard query rules。
- Audit is separate from RunLogStore and xterm output；a command/output marker must appear only in its expected channel in E2E。
- Real Shell integration、command boundaries、exit code attribution、tamper resistance and MySQL persistence are mandatory Stage 6 evidence。

## Target File Structure

```text
poc4/frontend/src/
├─ api/
│  ├─ terminalApi.ts
│  └─ terminalApi.test.ts
├─ contracts/
│  ├─ api.ts
│  ├─ terminal.ts
│  └─ terminal.test.ts
├─ components/
│  └─ terminal/
│     ├─ JobTerminalPanel.tsx
│     ├─ JobTerminalPanel.test.tsx
│     ├─ JobTerminalToolbar.tsx
│     ├─ JobTerminalSearch.tsx
│     ├─ TerminalAuditView.tsx
│     └─ CloseTerminalDialog.tsx
├─ features/
│  └─ terminal/
│     ├─ terminalQueries.ts
│     ├─ terminalQueries.test.ts
│     ├─ JobTerminalController.ts
│     ├─ JobTerminalController.test.ts
│     ├─ JobTerminalTransport.ts
│     ├─ JobTerminalTransport.test.ts
│     ├─ TerminalInputPump.ts
│     ├─ TerminalInputPump.test.ts
│     ├─ XtermTerminalAdapter.ts
│     └─ XtermTerminalAdapter.test.ts
├─ mocks/
│  ├─ terminalState.ts
│  ├─ terminalState.test.ts
│  ├─ terminalHandlers.ts
│  ├─ terminalSocket.ts
│  └─ terminalSocket.test.ts
└─ components/shell/WorkbenchShell.tsx

poc4/frontend/tests/e2e/
├─ stage5.spec.ts
└─ stage5-terminal-stress.spec.ts

poc4/docs/evidence/stage-5/
├─ result.md
└─ chrome/edge PNG evidence
```

Existing `src/terminal/**` and `components/terminal/TerminalPanel.tsx` remain Stage 0 only。Do not rename/delete them in Stage 5 unless a strictly required test fixture conflict is proven。

## Task 1: Define Stage 5 Contracts And Browser Boundaries

**Files:**

- Modify: `poc4/frontend/scripts/browser-boundary-lib.mjs`
- Modify: `poc4/frontend/scripts/browser-boundary-lib.test.mjs`
- Modify: `poc4/frontend/scripts/check-browser-boundary.mjs`
- Modify: `poc4/frontend/src/contracts/api.ts`
- Create: `poc4/frontend/src/contracts/terminal.ts`
- Create: `poc4/frontend/src/contracts/terminal.test.ts`
- Create: `poc4/frontend/src/api/terminalApi.ts`
- Create: `poc4/frontend/src/api/terminalApi.test.ts`

- [ ] **Step 1: Write failing Stage 5 allowlist boundary tests**

Add only new production `features/terminal/**`、`JobTerminal*`、Audit/dialog、`terminalApi` and `contracts/terminal` to workbench modules。Continue rejecting old `src/terminal/**`、Stage 0 `TerminalPanel`、Spike、mocks、echo server、Node built-ins、Electron、`node-pty` and physical/Kubernetes resource identifiers。

- [ ] **Step 2: Add production-string exclusions**

Add exact Stage 5 mock scenario endpoint、mock terminal ticket/session/audit prefixes、stress markers and persistence key to source/dist scans。Retain every Stage 0-4 needle。

- [ ] **Step 3: Write strict session/audit parser tests**

Cover opaque IDs、exact keys、ticket expiry、cols/rows bounds、response host/path rejection、all audit state/timestamp/exit invariants、sort/dedupe/cursor and command/control-character rendering safety。

- [ ] **Step 4: Write strict WebSocket control parser tests**

Cover all client/server controls、frame size、nonce、ready session match supplied by caller、credit/ack bounds、exit/error combinations、unknown types/keys and invalid resize。Binary bytes are validated separately, not JSON-decoded。

- [ ] **Step 5: Implement exact Terminal HTTP API**

Add `createTerminalSession(projectId, runId, {cols,rows})` and `listTerminalAudits(projectId, runId, cursor)`。Assert encoded opaque IDs/cursor、Bearer、AbortSignal、exact body and zero JWT/command/container/resource fields。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/contracts/terminal.test.ts src/api/terminalApi.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/scripts poc4/frontend/src/contracts poc4/frontend/src/api
git -C ../.. commit -m "feat(poc4): define stage 5 terminal contracts"
```

## Task 2: Build Deterministic Terminal Reservation, Session And Audit Mock State

**Files:**

- Create: `poc4/frontend/src/mocks/terminalState.ts`
- Create: `poc4/frontend/src/mocks/terminalState.test.ts`
- Create: `poc4/frontend/src/mocks/terminalHandlers.ts`
- Modify: `poc4/frontend/src/mocks/state.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/handlers.test.ts`

- [ ] **Step 1: Write owner/Run-state matrix tests**

Test owned READY + active RUNNING success；unknown/non-owned、STARTING、STOPPING、RECOVERING、terminal/history run rejection；Alice/Bob same IDs isolation；no physical identifier in response/error。

- [ ] **Step 2: Implement reservation and ticket lifecycle**

Issue opaque 30-second ticket bound to user/project/run/session and initial dimensions。HTTP does not activate session。Test expiry、single use、wrong owner/run/session、reset cleanup and multiple unused reservations。

- [ ] **Step 3: Enforce one live session**

First successful ticket consumption atomically creates live session。Second concurrent handshake is rejected even with a valid unused ticket。Closed/interrupted session permits a later new session with different IDs。

- [ ] **Step 4: Model session exit and Run transitions**

Mock Run leaving RUNNING first invalidates every bound unused reservation, then closes all live sessions before emitting/settling terminal state。Client disconnect marks session interrupted。User close marks closed/exit。None of these mutate Run state from terminal code。

- [ ] **Step 5: Add structured audit fixtures**

Create server-side audit records independent of frontend input parsing。Cover running/success/failure/interrupted、pagination/sort/retention query and owner isolation。Do not store raw terminal output in audit。

- [ ] **Step 6: Add Stage 5 scenario endpoint**

One authenticated mock-only endpoint selects normal、ticket-expired、already-active、server-pause、disconnect、shell-exit、WebGL-fallback fixture、audit、stress scenarios。Production modules never call/import it。

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test -- src/mocks/terminalState.test.ts src/mocks/handlers.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/mocks
git -C ../.. commit -m "test(poc4): model terminal sessions and audits"
```

## Task 3: Implement Mock PTY WebSocket And Credit Protocol

**Files:**

- Create: `poc4/frontend/src/mocks/terminalSocket.ts`
- Create: `poc4/frontend/src/mocks/terminalSocket.test.ts`
- Modify: `poc4/frontend/src/mocks/browser.ts`
- Modify: `poc4/frontend/src/mocks/node.ts`
- Modify: `poc4/frontend/src/test/setup.ts`

- [ ] **Step 1: Write handshake rejection tests**

Cover missing/expired/used/wrong ticket、second live session、session unavailable and retryable server failure。Assert application close codes and no PTY creation before successful consumption。

- [ ] **Step 2: Implement `ws.link()` fixed terminal endpoint**

Intercept only same-origin `/api/v1/ws/terminals`。Consume ticket, create live session, send one ready, require initial resize/credit, reject duplicate ready/control and unexpected data type。

- [ ] **Step 3: Implement binary input/output echo fixture**

Preserve arbitrary bytes including NUL/control/UTF-8 fragments。Test direction separation、frame <=32 KiB、ordered bytes and zero JSON reinterpretation。

- [ ] **Step 4: Implement server output credit accounting**

Send only within granted credit, queue mock PTY output server-side, validate exact acks and cap outstanding at 256 KiB。Ack mismatch/timeout closes with protocol/output-flow error。

- [ ] **Step 5: Implement input pause、heartbeat and destroy semantics**

Support pause/resume、ping/pong、user close、socket close、Run-left-RUNNING and shell-exit。Each path unsubscribes listeners、destroys mock exec once and finalizes structured session/audit state。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/mocks/terminalSocket.test.ts src/mocks/terminalState.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/mocks poc4/frontend/src/test/setup.ts
git -C ../.. commit -m "test(poc4): bridge mock PTY terminal bytes"
```

## Task 4: Implement Terminal Input Pump And WebSocket Transport

**Files:**

- Create: `poc4/frontend/src/features/terminal/TerminalInputPump.ts`
- Create: `poc4/frontend/src/features/terminal/TerminalInputPump.test.ts`
- Create: `poc4/frontend/src/features/terminal/JobTerminalTransport.ts`
- Create: `poc4/frontend/src/features/terminal/JobTerminalTransport.test.ts`

- [ ] **Step 1: Write byte conversion tests**

Prove `onData` Unicode -> exact UTF-8、`onBinary` code units -> low-byte exactness、large paste chunking、NUL/control preservation and no double encoding。

- [ ] **Step 2: Implement bounded FIFO input pump**

16 KiB frames、1 MiB queue、bufferedAmount high/low watermarks、injectable scheduler and pause-state callback。No send outside OPEN；dispose clears data/timers。

- [ ] **Step 3: Implement transport state/generation**

Fixed same-origin URL、`binaryType=arraybuffer`、captured auth token binding、sessionId match、strict control parser、ready/close/error/heartbeat lifecycle。Old generation events after dispose do nothing。

- [ ] **Step 4: Implement output credit/ack integration seam**

Transport exposes ordered output delivery with byte count and an ack callback that can be invoked only once after xterm parse。Initial credit exactly once；ack before ready/duplicate/mismatched bytes fail closed。

- [ ] **Step 5: Implement no-reconnect policy**

Any post-handshake socket close ends the controller generation。No backoff、no new ticket、no resume cursor。Expose explicit closed reason so UI can offer New terminal when Run remains RUNNING。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/terminal/TerminalInputPump.test.ts src/features/terminal/JobTerminalTransport.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/terminal
git -C ../.. commit -m "feat(poc4): transport bounded terminal IO"
```

## Task 5: Build Xterm Adapter, Resize, Search And WebGL Fallback

**Files:**

- Create: `poc4/frontend/src/features/terminal/XtermTerminalAdapter.ts`
- Create: `poc4/frontend/src/features/terminal/XtermTerminalAdapter.test.ts`
- Create: `poc4/frontend/src/components/terminal/JobTerminalSearch.tsx`
- Create: `poc4/frontend/src/components/terminal/JobTerminalSearch.test.tsx`
- Modify: `poc4/frontend/src/components/terminal/TerminalSearchBar.tsx` only if a shared accessibility fix is required

- [ ] **Step 1: Define an injectable xterm port**

Wrap only public Terminal/Fit/Search/WebGL APIs used by production。Tests use fake ports rather than canvas internals。Expose open、focus、setInputEnabled、write-with-callback、fit/propose、search、clear and dispose。

- [ ] **Step 2: Write lifecycle and dispose tests**

Test create/open once、ready focus、ordered write callbacks、reverse dispose、idempotency、one disposer throwing、new session gets entirely new resources and old write callbacks/listeners/ResizeObserver frames cannot ack or resize the new generation。

- [ ] **Step 3: Implement resize coalescing**

ResizeObserver/activation schedule once per animation frame、skip zero/same/invalid dimensions、bounds check、ready gate and reconnect-free dispose。Stress fake observer >=100 events with bounded resize sends。

- [ ] **Step 4: Implement WebGL fallback**

Load after Terminal open。Constructor/load failure or `onContextLoss` disposes WebglAddon and records renderer `dom` without disposing Terminal。Search/input/output/fit continue。

- [ ] **Step 5: Harden search and focus**

`Ctrl/Cmd+F` only active panel；input labelled；case/whole/regex toggles have `aria-pressed` and accessible names；no result text/status；Escape restores xterm focus；inactive panel shortcut ignored。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/terminal/XtermTerminalAdapter.test.ts src/components/terminal/JobTerminalSearch.test.tsx
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/terminal poc4/frontend/src/components/terminal
git -C ../.. commit -m "feat(poc4): render resilient job terminals"
```

## Task 6: Implement Controller And Terminal Audit Queries

**Files:**

- Create: `poc4/frontend/src/features/terminal/JobTerminalController.ts`
- Create: `poc4/frontend/src/features/terminal/JobTerminalController.test.ts`
- Create: `poc4/frontend/src/features/terminal/terminalQueries.ts`
- Create: `poc4/frontend/src/features/terminal/terminalQueries.test.ts`
- Modify: `poc4/frontend/src/app/appRuntime.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/runtime/ConnectionRegistry.test.ts`
- Modify: `poc4/frontend/src/runtime/WorkspaceResourceRegistry.test.ts`

- [ ] **Step 1: Write the controller transition matrix**

Cover unavailable/available/create/connect/ready/pause/close/exit/error、double open/close、Run ID/state changes、panel switch、pagehide、logout/401、project switch and stale callback generation。

- [ ] **Step 2: Implement explicit Open orchestration**

Create xterm first、derive valid fit dimensions、POST reservation、construct transport/controller generation、open socket、match ready、send resize/credit、focus。Failure disposes everything and keeps no reusable ticket。

- [ ] **Step 3: Implement close-before-reload ordering**

When active Run leaves RUNNING, synchronously disable stdin、mark closing and close transport before workspace reload resource disposal proceeds。Test terminal exit/close cannot call Run coordinator complete/unlock。

- [ ] **Step 4: Register resources centrally**

Register socket closer in `ConnectionRegistry` and controller/xterm disposer in `WorkspaceResourceRegistry` after lazy module load。Global appRuntime must not statically import xterm/terminal heavy modules。

- [ ] **Step 5: Implement audit query**

Project/run key、cursor pagination、retry only transient 5xx/network、no retry 401/403、2s polling only while READY and final invalidate on exit。No controller/ticket/output in query cache。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/terminal src/app/appRuntime.test.ts src/runtime
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/terminal poc4/frontend/src/app poc4/frontend/src/runtime
git -C ../.. commit -m "feat(poc4): coordinate terminal session lifecycle"
```

## Task 7: Build Terminal Panel And Audit View

**Files:**

- Create: `poc4/frontend/src/components/terminal/JobTerminalPanel.tsx`
- Create: `poc4/frontend/src/components/terminal/JobTerminalPanel.test.tsx`
- Create: `poc4/frontend/src/components/terminal/JobTerminalToolbar.tsx`
- Create: `poc4/frontend/src/components/terminal/TerminalAuditView.tsx`
- Create: `poc4/frontend/src/components/terminal/TerminalAuditView.test.tsx`
- Create: `poc4/frontend/src/components/terminal/CloseTerminalDialog.tsx`
- Modify: `poc4/frontend/src/styles/globals.css`

- [ ] **Step 1: Write panel state matrix tests**

Cover authority loading、no run、STARTING/RUNNING/STOPPING/RECOVERING/terminal、creating/connecting/ready/paused/closed/exited/error、audit loading/error/empty/pages and renderer fallback。

- [ ] **Step 2: Build compact toolbar and Session/Audit tabs**

Open only when RUNNING/closed；Close only ready/paused/connecting；Clear/Search only active xterm；state and renderer text do not resize toolbar。Audit remains read-only and available for current/last session run。

- [ ] **Step 3: Build xterm viewport and local search**

Stable full-height region、nonblank loading state、overlay search within viewport、no nested cards。Ready focuses xterm；inactive panel is inert but remains mounted。

- [ ] **Step 4: Build safe Close dialog**

Explain session cannot resume；Cancel initial focus；Escape Cancel；Confirm disables input immediately and prevents double close；focus returns appropriately after completion。

- [ ] **Step 5: Build audit table/list**

Show command、state、start/finish、exit code and Load more。Long command wraps/truncates with full accessible text；control characters cannot create markup or overlap。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/terminal/JobTerminalPanel.test.tsx src/components/terminal/TerminalAuditView.test.tsx
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components/terminal poc4/frontend/src/styles/globals.css
git -C ../.. commit -m "feat(poc4): add active run terminal panel"
```

## Task 8: Integrate Terminal With Workbench And Run Authority

**Files:**

- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/features/projects/WorkbenchPage.tsx`
- Modify: `poc4/frontend/src/features/editor/runPreconditions.ts`
- Modify: `poc4/frontend/src/features/editor/runPreconditions.test.ts`
- Modify: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.ts`
- Modify: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.test.ts`

- [ ] **Step 1: Lazy load the production terminal panel**

Terminal tab first selection triggers `lazy(() => import(...JobTerminalPanel))`。Before selection no xterm network/chunk/session。After load, File/Run/Terminal remain mounted with correct inert/aria-hidden semantics。

- [ ] **Step 2: Replace Stage 4 unavailable seam**

Terminal tab becomes selectable in Stage 5, but Open availability derives only from active authority `RUNNING`。Dirty is irrelevant because Run already locks writes；history selection cannot enable Open。

- [ ] **Step 3: Preserve sessions across panel switches**

File/Run/Terminal switching keeps one xterm/socket and does not send close。Inactive terminal cannot receive keyboard/search shortcuts。Reactivation refits/sends changed resize。

- [ ] **Step 4: Close on Run lifecycle before reload**

Run state `RUNNING -> STOPPING/RECOVERING/terminal/null-confirmation` disables terminal input and closes old session before Stage 4 reload。Simultaneous log/state/query events invoke terminal close once。

- [ ] **Step 5: Preserve Run/log separation**

Terminal controls never call RunLogTransport/RunLogStore；Run panel log socket remains independent。Terminal exit/socket close never starts/stops/unlocks Run。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/shell/WorkbenchShell.test.tsx src/features/editor/runPreconditions.test.ts src/features/runs/RunAuthorityCoordinator.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components/shell poc4/frontend/src/features
git -C ../.. commit -m "feat(poc4): bind terminal to active run authority"
```

## Task 9: Harden Security, Cleanup And Channel Isolation

**Files:**

- Modify: `poc4/frontend/src/features/terminal/JobTerminalController.ts`
- Modify: `poc4/frontend/src/features/terminal/JobTerminalController.test.ts`
- Modify: `poc4/frontend/src/features/terminal/JobTerminalTransport.ts`
- Modify: `poc4/frontend/src/features/terminal/JobTerminalTransport.test.ts`
- Modify: `poc4/frontend/src/features/terminal/terminalQueries.test.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/mocks/terminalSocket.test.ts`

- [ ] **Step 1: Test cleanup ordering and idempotency**

Input disable -> pump stop -> when socket is OPEN send terminal.close control -> socket close -> observers/addons/xterm dispose -> audit invalidate。Already closed/failed sockets skip the control send but execute every remaining cleanup step。Every path runs once even when close/error/Run state/logout race；one disposer throwing cannot leave other connections live。

- [ ] **Step 2: Bind unauthenticated events to captured token**

Ticket HTTP 401 uses HttpClient current-token rule。WebSocket 4401/UNAUTHENTICATED may clear auth only when ticket's captured token is still current。Alice stale socket cannot close/clear Bob session。

- [ ] **Step 3: Test ticket/session confidentiality**

Ticket/session ID absent from visible DOM、console、error body、audit command、screenshot name and Run logs。URL contains only short ticket, never JWT。Close reason text is ignored/not rendered。

- [ ] **Step 4: Prove channel isolation with markers**

PTY input marker appears in mock terminal output only；backend audit fixture appears audit only；Run log marker appears Run panel only。No component imports another channel's store/transport。

- [ ] **Step 5: Test no automatic recovery**

Disconnect consumes/destroys old session；zero follow-up ticket/WS until explicit Open。New Open receives new IDs and old generation binary/control events are ignored。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/terminal src/mocks/terminalSocket.test.ts src/app/appRuntime.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/terminal poc4/frontend/src/mocks poc4/frontend/src/app
git -C ../.. commit -m "fix(poc4): harden terminal isolation and cleanup"
```

## Task 10: Add Browser, Visual And Terminal Stress Evidence

**Files:**

- Create: `poc4/frontend/tests/e2e/stage5.spec.ts`
- Create: `poc4/frontend/tests/e2e/stage5-terminal-stress.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-5/chrome-terminal-1280x720.png`
- Create: `poc4/docs/evidence/stage-5/chrome-terminal-1440x900.png`
- Create: `poc4/docs/evidence/stage-5/chrome-terminal-1920x1080.png`
- Create: `poc4/docs/evidence/stage-5/chrome-audit-1280x720.png`
- Create: `poc4/docs/evidence/stage-5/chrome-audit-1440x900.png`
- Create: `poc4/docs/evidence/stage-5/chrome-audit-1920x1080.png`
- Create: matching six Edge PNG files

- [ ] **Step 1: Add Stage 5 functional E2E**

At minimum cover:

1. Terminal lazy chunk/no auto session before selection/Open；
2. Open only active RUNNING and POST body exact cols/rows/no policy fields；
3. JWT absent、single-use ticket、same-origin WS、ready/session match；
4. Unicode `onData` echo、control-byte `onBinary` fixture、binary frame direction；
5. initial resize、panel switch persistence、reactivation resize dedupe；
6. Search focus/options/no-result/Escape return、Clear display local only；
7. server input pause/resume and bufferedAmount simulated pause；
8. Close dialog Cancel/Escape/Confirm and zero old-session reuse；
9. abnormal disconnect -> no reconnect -> explicit new session/new IDs；
10. shell exit and Run STOPPING/RECOVERING/terminal disable input/close before reload；
11. logout/current 401/project switch closes；stale Alice 401 leaves Bob；
12. audit pagination/rendering and no frontend keystroke inference；
13. PTY/audit/Run log markers isolated；
14. WebGL failure/context-loss fallback retains terminal/search/resize；
15. historical/no-active Run cannot create terminal。

- [ ] **Step 2: Add dedicated stress project**

Create `chromium-terminal-stress` with 180-second timeout and only Stage 5 stress spec。Stream at least 8 MiB actual binary output in <=32 KiB frames under 256 KiB credit，inject input burst and >=100 ResizeObserver events，force one pause/resume and finish with unique marker。

- [ ] **Step 3: Assert flow-control/performance evidence**

Record generated/delivered/acked/max-outstanding bytes、input queued/sent/max-buffered、resize observed/sent、ready/final-marker time、renderer/fallback、console/page errors and responsiveness probe。Require byte conservation、max outstanding <=256 KiB、zero xterm discard error、final marker once、page responsive <5s。

- [ ] **Step 4: Add Chrome/Edge screenshots and pixel/geometry assertions**

Capture ready Terminal and Audit at 1280x720、1440x900、1920x1080。Assert no document overflow、toolbar/search/audit/status in viewport、xterm canvas or DOM rows contain non-background pixels/text、Terminal does not overlap header/sidebar/panel tabs。

- [ ] **Step 5: Add keyboard/accessibility assertions**

Keyboard-only File -> Run -> Terminal -> Open -> xterm -> Search -> Audit -> Close dialog。Assert focus rings、Search Escape return、Close Cancel focus/return、status/error announcements、inactive panel inert and reduced motion。

- [ ] **Step 6: Update scripts and README**

Add `test:e2e:terminal-stress` using pnpm。README documents mock-only terminal contract、single-use ticket、no reconnect、flow control、audit boundary and Stage 6 real-system gaps。

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test:e2e
pnpm test:e2e:terminal-stress
pnpm test:e2e:channels
git -C ../.. diff --check
git -C ../.. add poc4/frontend/tests poc4/frontend/playwright.config.ts poc4/frontend/package.json poc4/frontend/README.md poc4/docs/evidence/stage-5
git -C ../.. commit -m "test(poc4): verify stage 5 active job terminal"
```

Channel runs may recapture prior PNGs。Inspect exact paths and restore only known prior-stage recaptures；do not touch `.grok/` or user files。

## Task 11: Final Verification And Stage 5 Evidence Report

**Files:**

- Create: `poc4/docs/evidence/stage-5/result.md`

- [ ] **Step 1: Run the complete matrix from one immutable source SHA**

```powershell
pnpm test:boundary
pnpm typecheck
pnpm test
pnpm build
pnpm build:mock
pnpm test:e2e
pnpm test:e2e:channels
pnpm test:e2e:large-files
pnpm test:e2e:large-writes
pnpm test:e2e:large-logs
pnpm test:e2e:terminal-stress
```

Record source SHA、commands、exit codes、exact test counts and durations。After mock/E2E overwrites `dist`，rerun production build before scans。

- [ ] **Step 2: Scan production output and chunks**

Require zero prior needles plus Stage 5 scenario/ticket/session/audit/stress markers。Confirm no `stage0.html`/MSW worker/echo URL；entry and initial Workbench chunk do not statically include xterm；a dedicated lazy terminal chunk and xterm CSS exist；production terminal modules contain no old `src/terminal`、mock、Electron、Node、physical resource identifiers。

- [ ] **Step 3: Record session/ticket/lifecycle evidence**

Document exact HTTP body、ticket expiry/use counts、handshake/session creation point、one-live enforcement、close/disconnect/new-session IDs、Run state close ordering and cleanup registry。Redact token/ticket/session values。

- [ ] **Step 4: Record byte/flow/resize/render evidence**

Include `onData/onBinary` byte samples、credit/ack traces、bufferedAmount/pump stats、resize coalescing、WebGL fallback、search/focus and real 8 MiB measurements。Do not claim production SLA。

- [ ] **Step 5: Record audit/channel-isolation evidence**

Document audit query/pagination/state examples、frontend no-parser scan、PTY/audit/Run-log marker isolation and command text safety。State that mock structured audit does not prove real Shell integration or MySQL。

- [ ] **Step 6: Record unresolved real-system evidence**

Explicitly list real Spring Boot JWT/owner、Fabric8 PTY exec into current Maven app container、disconnect process destruction、Run end close、input/output flow at proxy/backend、command-boundary integration、MySQL audit、PVC side effects and full backend restart/cluster E2E。

- [ ] **Step 7: Verify repository hygiene**

```powershell
git -C ../.. diff --check
git -C ../.. status --short
```

Strictly decode tracked text under `poc4/frontend` and `poc4/docs` as UTF-8，report BOM/CR counts under current policy，exclude `.grok/`、worktrees、traces、videos、reports and recaptured prior PNGs。

- [ ] **Step 8: Make the decision**

Only when all 17 exit gates pass，write：

```text
READY_FOR_STAGE_6_PLAN
```

Otherwise write：

```text
STAGE_5_REMEDIATION_REQUIRED
```

List every failed gate and do not start real-system implementation。

- [ ] **Step 9: Commit the report**

```powershell
git -C ../.. add poc4/docs/evidence/stage-5/result.md poc4/frontend/README.md
git -C ../.. commit -m "docs(poc4): record stage 5 active job terminal result"
```

## Verification Matrix

| Layer | Required evidence |
|---|---|
| Contracts | session/audit/control exact parsers、bounds、HTTP shape、fixed URL |
| Mock authority | owner/READY/active RUNNING/one-live/ticket/session/exit |
| Binary protocol | onData/onBinary exact bytes、direction、frame limits、control isolation |
| Flow control | 256 KiB output credit、write callback ack、input pump/bufferedAmount |
| Controller | explicit Open、no reconnect、Run lifecycle、generation、idempotent cleanup |
| Xterm | new instance/session、Fit/Search/WebGL fallback、focus、dispose |
| Audit | backend fixture only、pagination、states、safe rendering、no frontend parser |
| Workbench | lazy Terminal、three mounted panels、authority gating、Run/log separation |
| Browsers | Chromium regression、Chrome/Edge core + 12 Stage 5 screenshots |
| Stress | actual >=8 MiB、input burst、>=100 resize、byte conservation、responsive page |
| Production | mock/echo/old terminal/physical identifiers zero、lazy xterm chunk |
| Hygiene | pnpm matrix、build、diff、UTF-8、BOM、scoped clean status |

## Acceptance Traceability

| POC4 rule | Stage 5 proof | Still deferred |
|---|---|---|
| Only active Maven Job terminal | authority + mock handler state checks | Real target container selection |
| Ticket instead of JWT URL | HTTP ticket + fixed same-origin WS | Real backend handshake/auth |
| Input/output/resize | Binary/control protocol + browser E2E | Real Kubernetes PTY fidelity |
| Disconnect destroys old session | mock destroy + no reconnect/new IDs | Real exec/process destruction |
| Run end prevents input | authority close before reload | Real backend Run/PTY race |
| New session on same active Run | explicit Open after closed | Real exec recreation |
| Command audit | structured query/display and no frontend parser | Real Shell/wrapper + MySQL audit |
| Terminal output separate from logs | store/import/marker isolation | Real backend channel routing |
| Continuous output | real 8 MiB browser flow-control stress | Proxy/backend/cluster SLA |
| Browser boundary | source/dist/chunk scans | Full real-system threat validation |

## Known Risks Carried Forward

1. **真实 Kubernetes PTY 是最大证据缺口。** Mock echo cannot prove Fabric8 exec、TTY、signals、child process and container identity。
2. **Native WebSocket has no built-in backpressure.** Credit/ack and bufferedAmount reduce browser risk but real proxy/backend must honor them。
3. **xterm beta APIs can drift.** Exact locked versions and public API tests are mandatory；do not upgrade during Stage 5。
4. **Disconnect process destruction is server-side.** Browser close event cannot prove old exec or child processes ended。
5. **Command audit attribution is hard.** Frontend parsing is forbidden；real Shell integration may fail on multiline、interactive programs or signals。
6. **Terminal can mutate PVC.** This is an accepted controlled-test-cluster risk；Stage 4 terminal reload must expose resulting file changes，not provide immutable runs。
7. **WebGL/canvas differs by browser/GPU.** DOM fallback must remain complete and visually tested。
8. **Large paste/input ambiguity.** Bounded queue avoids silent memory growth，but overflow ends the session and may have already sent a prefix；UI must state failure honestly。
9. **Session and Run events race.** Run authority always wins；terminal close cannot mutate/unlock Run and must be generation-safe。
10. **Stage 6 remains substantial.** Frontend completion is not POC4 completion until real auth/files/Run/log/terminal/audit and restart recovery are integrated。

## Rollback Boundaries

- Contract/mock failure：回退 Task 1-3，Stage 4 Run/log remains intact。
- Transport/xterm failure：回退 Task 4-5，Terminal tab stays unavailable。
- Controller/UI failure：回退 Task 6-7，do not expose partially safe terminal。
- Integration/cleanup failure：回退 Task 8-9，do not weaken Run authority or Stage 4 reload。
- Browser/stress failure：fix Task 10，do not lower real-byte、flow-control、Chrome/Edge or visual gates。

不得通过自动重连旧 PTY、丢弃输入、把 Run log transport 改成双向 terminal、解析浏览器按键作 audit、直接导入 Stage 0 echo URL、扩大 xterm discard watermark、缩小 8 MiB stress、跳过真实 channel 浏览器或把 mock 称为 Kubernetes 证据来放行。

## Execution Start Condition

执行前必须：

1. 确认 Stage 4 merge `6334db4` 或其后继提交在目标基线，Stage 4 decision 为 `READY_FOR_STAGE_5_PLAN`。
2. 本计划经过用户确认并提交到 `master`。
3. 从该提交创建隔离工作树和 `codex/poc4-stage-5-active-job-terminal` 分支。
4. 保持 EnsoAI 来源 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；只复用浏览器 xterm 显示/搜索/fit/主题，不复制 Electron IPC、`node-pty`、本机路径或旧 PTY 复用语义。
5. 保留 `.grok/` 未跟踪目录，不修改、不提交。
6. 执行只从 Task 1 开始；完成后停在 `READY_FOR_STAGE_6_PLAN`，不自动进入真实后端/Kubernetes 集成。
