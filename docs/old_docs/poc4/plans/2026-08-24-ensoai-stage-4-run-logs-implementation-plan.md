# EnsoAI Stage 4 Run And Logs Implementation Plan

> **Execution rule:** Implement task by task in a new isolated worktree created from the accepted Stage 4 plan commit. Use TDD for every behavior change, pnpm for every package operation, small focused patches, and one focused commit per task. Do not start Stage 5 terminal work or Stage 6 real-backend integration from this plan.

**Goal:** 在阶段 3 可写工作台基础上交付服务器权威的 Run 与日志前端闭环：启动固定 `mvn clean test`、停止、活动 Run 恢复、运行期编辑锁、终态后强制重载工作区、最近运行列表，以及持久化窗口的日志 replay/live、5 MiB 截断提示和断线补拉。

**Architecture:** TanStack Query 独占 Run、history 和 active authority 等服务端状态；前端不得从按钮、WebSocket 连接状态或本地计时器推断 Run 已结束。`RunAuthorityCoordinator` 只管理 `LOADING_AUTHORITY`、`RELOADING_WORKSPACE` 和 reload failure 等客户端协调阶段。`RunLogTransport` 使用短期单次 ticket 建立同源原生 WebSocket，`RunLogStore` 以 project/run 为键保存有界日志窗口、序列游标和连接状态，并通过批量订阅驱动 React，避免每个日志帧触发整页 state 更新。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、React Router 8.3.0、TanStack Query 5.101.4、Zustand 5.0.15、MSW 2.15.0 WebSocket API、Vitest、Testing Library、Playwright、Tailwind CSS 4、Lucide React。Stage 4 不新增生产依赖，不升级 Monaco、xterm 或现有框架。

**Current documentation checked on 2026-08-24:** TanStack Query v5 官方资料确认 mutation 默认不重试、`onSettled` 可保持 pending 直到 authoritative refetch 完成、imperative refetch 默认取消旧请求；React Router 官方资料确认 `useBlocker` 的 `blocked -> proceed/reset` 生命周期，但 Context7 未提供安装版本 8.3.0 的专属文档，执行导航相关改动前仍需按锁文件版本复核；MSW 官方资料确认 `ws.link()`、connection/message/close 事件可模拟原生 WebSocket；xterm 官方资料已核对但本阶段不接入生产终端。

---

## Scope And Non-Negotiable Boundaries

### Included

- 进入 `READY` 项目后，先查询权威 active Run，再决定工作台是否可编辑。
- Run 状态：`STARTING`、`RUNNING`、`STOPPING`、`RECOVERING`、`SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`。
- 启动固定 Maven Run；请求只携带 `expectedWorkspaceRevision`，不接受浏览器提供命令、镜像或资源配置。
- 每项目一个活动 Run；重复启动和 revision 冲突后重新获取权威 active state。
- 停止当前活动 Run；停止请求幂等，`STOPPING`/网络不确定期间保持锁定。
- 活动 Run 查询、最近 Run 列表和选中历史 Run 查看日志。
- HTTP 获取约 30 秒有效、单次使用且绑定用户/project/run 的 log ticket。
- 同源 WebSocket 日志 replay/live、单调 `seq` 去重、缺口重连、心跳超时和 generation 隔离。
- 每次 Run 最近 5 MiB 持久化窗口的 `truncated`、`evictedBytes`、`firstAvailableSeq` 展示。
- Run 到达终态后，强制清理文件 cache/models/buffers 并重新读取树和原打开文件；成功前不解锁编辑。
- mock HTTP/WebSocket、单元/组件测试、Chromium/Chrome/Edge E2E、视觉证据和真实超过 5 MiB 的日志压力验证。

### Explicitly excluded

- 真实 Spring Boot、JWT 签名、MySQL、Fabric8、Kubernetes Job、Pod log、PVC 或集群资源创建。
- 真实 `mvn clean test` 执行、真实 30 分钟超时、真实 CPU/内存/临时存储限制验证。
- 后端重启后从 MySQL/Kubernetes 恢复 Run；它属于 Stage 6。
- xterm、PTY、terminal ticket、terminal resize/input、命令审计和 Terminal panel；它们属于 Stage 5。
- 浏览器任意命令、环境变量、镜像、Maven 参数或资源配置输入。
- 自动停止 Run 后再离开、关闭页面即停止、离开工作台确认；Run 在服务端继续，导航/logout 只关闭本页连接。
- 日志下载、日志搜索、高亮、ANSI 解释、跨 Run 合并和无限历史。
- AI 读取日志、自动修复、Git 集成、并发编辑合并和生产级网络隔离。

### Evidence interpretation

- 本阶段所有 Run、锁、ticket、日志持久化和 5 MiB 淘汰结果只能称为 **mock contract verified**。
- MSW 可以证明浏览器合同、状态机、序列处理和资源生命周期，不能证明真实 Job 创建、MySQL 先持久化后推送、Pod 日志完整性、超时执行、跨用户授权或后端重启恢复。
- 真实后端/Kubernetes 仍是本阶段结束后的最大证据缺口；不得因为 UI 显示 `RUNNING` 就声称 Maven 在集群中运行。
- 浏览器不得接收或显示 PVC、Pod、Job、Namespace、ServiceAccount、容器名或物理绝对路径。`runId` 是不透明业务 ID，不是 Kubernetes Job 名称。
- UI disabled、WebSocket ticket、query cache 和 project-scoped mutation queue 都不是授权边界；真实后端必须重新校验 JWT owner、project、revision、active Run 和状态转换。

### Stage 4 versus Stage 5

生产 Run panel 在 Stage 4 可用，Terminal tab 继续 disabled。日志 WebSocket 只能接收日志和 Run control event，不能发送终端输入或 resize，也不能导入 `src/terminal/**`、`TerminalPanel`、`xterm` 或 Stage 0 echo transport。Stage 4 退出不能以终端 Spike 代替日志证明。

### UI and accessibility guardrails

- 保持 EnsoAI 已验收的紧凑 IDE shell、主题、256 px 文件树和现有排版。Run 是工作面板，不是 dashboard landing page。
- 拒绝 `ui-ux-pro-max` 返回的横向营销旅程、鲜艳 block layout、32 px 大标题、浮动 CTA、卡片堆叠和 hover scale。
- File/Run panel 一直挂载；非活动面板使用不可见且不可交互状态，避免切换导致 dirty buffer、日志 scroll 或连接生命周期丢失。
- Run toolbar 使用 Lucide Play、Square、Refresh/CircleArrowOutUpRight 等现有语义图标；icon-only 操作有 `title`、`aria-label`、固定 32 px 命中框和可见 focus ring。
- Start 是清晰命令；Stop 必须经过确认，默认焦点在 Cancel，Escape 等价 Cancel，关闭恢复触发元素焦点。
- Run 状态不能只用颜色表达；状态文本、图标和 `role="status"` 同时存在。错误用 `role="alert"`，重连/补拉等被动变化用克制的 `role="status"`。
- 日志区域使用等宽字体、可键盘聚焦、文本可选择。用户向上滚动后停止 auto-follow，并显示固定尺寸的 New output 按钮；用户回到底部或点击按钮后恢复。
- 1280 px 下最近运行列表、toolbar、状态、日志和截断提示无重叠/裁切；不支持移动端，不按 viewport width 缩放字体。
- hover 只改变颜色/透明度，遵守 `prefers-reduced-motion`，不得用快速闪烁表示日志活动。

### Stage 4 exit gate

只有以下条件全部满足，阶段 4 才结束：

1. 所有 Run/日志响应经过运行时验证；不透明 `runId`、cursor、ticket 和 timestamp 无空值/越界，非法状态组合整包拒绝，不渲染部分权威状态。
2. 启动请求只发送 `expectedWorkspaceRevision`；dirty、文件写 pending、revision 缺失、authority 未知或已有 active Run 时前端不发送请求，mock handler 仍独立拒绝绕过 UI 的请求。
3. 启动/停止/文件写共用 project authority mutation scope；同项目不并发。启动网络结果不确定或 `409` 后先 refetch active Run，再允许重试。
4. `LOADING_AUTHORITY`、`STARTING`、`RUNNING`、`STOPPING`、`RECOVERING`、`RELOADING_WORKSPACE` 和 reload failure 全部 fail closed；文件编辑、Save 和 CRUD 被锁，下载/查看不被误当写操作。
5. WebSocket 断开、ticket 失败、日志 complete 或浏览器离线都不能解锁；只有权威 active query/validated Run event 到达终态并且 workspace reload 成功后才解锁。
6. Stop 只针对当前 owned active Run，重复点击不发并行请求；幂等响应或 refetch 决定状态，客户端不乐观写成 `CANCELLED`。
7. log ticket 通过 Bearer HTTP 获取、约 30 秒有效、单次使用、绑定用户/project/run；主 JWT 不进入 WebSocket URL、frame、DOM、截图或日志。
8. 日志 replay 后再 live；`seq` 重复被忽略、乱序/缺口触发从 last applied seq 重新取新 ticket，旧 generation 的迟到 frame 无效。
9. 每个 append 在 mock persisted window 更新后才发送；replay/append 的 UTF-8 `byteLength`、窗口序号、`truncated` 和 `evictedBytes` 一致，客户端不自行伪造服务端淘汰事实。
10. 真实超过 5 MiB 的日志场景证明浏览器只保留服务端最近窗口、显示截断和淘汰字节，持续追加/重连不重复、不丢补拉窗口、不崩溃或失去响应。
11. 刷新/重进工作台可通过 active query 恢复锁和 Run panel；断线后通过 replay 恢复 lastSeq 之后的持久化缺口。mock-only persistence 只能标为合同证明。
12. 终态后捕获原打开路径，dispose buffer/models，移除旧文件 queries，重取根树/metadata/content；删除的文件关闭、新增文件在树中出现、修改文件显示新内容；任何 reload 失败都保持锁定并可重试。
13. 最近 Run 列表稳定按创建时间降序、cursor 分页、最多显示服务端返回记录；历史日志与活动日志隔离，切换 run 关闭旧 socket 并清除旧 generation。
14. Chromium、真实 Chrome、真实 Edge 核心流程通过；1280 px 无重叠/不可达操作；键盘可进入 File/Run、Start/Stop dialog、history、log 和 New output。
15. 生产构建不包含 MSW worker、mock 凭据、Stage 4 scenario endpoint、mock ticket、Stage 0 echo URL 或 `stage0.html`；生产 Run modules 不导入 terminal/Spike/mocks/Node built-ins/物理资源标识。

## First-Principles State Ownership

| State | Owner | Reason |
|---|---|---|
| active Run、history、Run summary | TanStack Query | 服务端权威状态，可 refetch/reconcile |
| start/stop/ticket pending/error | TanStack Mutation | 服务端操作生命周期，不持久化 |
| workspace revision、文件树/正文 | 既有 TanStack Query file keys | Run 启动和终态 reload 的一致性基础 |
| dirty/open tabs/selected tree | 既有 Zustand workspace session | 轻量浏览器会话 |
| authority bootstrap/reload phase | `RunAuthorityCoordinator` | 客户端协调状态，不复制 Run summary |
| 日志 chunks/lastSeq/window metadata | `RunLogStore` | 高频有界外部资源，避免 React state 每帧复制 |
| WebSocket/timer/generation | `RunLogTransport` + `ConnectionRegistry` | 明确 close/dispose，logout/401 可集中回收 |

禁止把 `RunSummary` 复制进 Zustand，禁止从日志文案推断 Run 状态，禁止把 5 MiB 日志字符串放进 React Context。Run query 是锁定权威，日志 store 只是展示与恢复游标。

## Run Contract Decisions

### Opaque identifiers and states

```ts
declare const runIdBrand: unique symbol;
declare const logTicketBrand: unique symbol;

export type RunId = string & { readonly [runIdBrand]: true };
export type LogTicket = string & { readonly [logTicketBrand]: true };

export type RunState =
  | 'STARTING'
  | 'RUNNING'
  | 'STOPPING'
  | 'RECOVERING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';
```

Active/locking states are `STARTING | RUNNING | STOPPING | RECOVERING`. Terminal states are `SUCCEEDED | FAILED | CANCELLED | TIMED_OUT`. Unknown states fail parsing; browser never maps them to editable.

### Run summary

```ts
export type RunTerminationReason =
  | 'BUILD_SUCCEEDED'
  | 'BUILD_FAILED'
  | 'USER_STOPPED'
  | 'TIME_LIMIT_EXCEEDED'
  | 'START_FAILED'
  | 'RECOVERY_FAILED';

export type RunResources = {
  cpuMillis: number;
  memoryBytes: number;
  ephemeralStorageBytes: number;
};

export type RunPolicy = {
  command: 'mvn clean test';
  runtime: { javaMajor: 17; mavenMajor: 3 };
  timeoutSeconds: number;
  resources: {
    requests: RunResources;
    limits: RunResources;
  };
};

export type RunSummary = {
  id: RunId;
  state: RunState;
  requestedWorkspaceRevision: WorkspaceRevision;
  policy: RunPolicy;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  terminationReason: RunTerminationReason | null;
  exitCode: number | null;
  logTruncated: boolean;
  logEvictedBytes: number;
  lastLogSeq: number | null;
};
```

Runtime invariants:

- `STARTING` has null `startedAt/finishedAt/terminationReason/exitCode`.
- `RUNNING` has non-null `startedAt` and null `finishedAt/terminationReason`. `STOPPING/RECOVERING` may have null `startedAt` when reached from `STARTING`, but still have null `finishedAt/terminationReason`.
- terminal states have non-null `finishedAt` and matching reason; `SUCCEEDED` requires exit 0, `FAILED` may have integer/null exit, `CANCELLED/TIMED_OUT` may have null exit.
- timestamps are valid ISO strings with `createdAt <= startedAt <= finishedAt` when present.
- `logEvictedBytes` and seq are non-negative safe integers; `logTruncated === false` requires zero evicted bytes.
- policy is server-owned. `timeoutSeconds` is a positive safe integer at most 1800. Resource values are positive safe integers with `requests <= limits` per dimension and limits at most 8000 CPU millis、17,179,869,184 memory bytes and 10,737,418,240 ephemeral-storage bytes. Command/runtime literals are fixed. Browser displays the parsed policy but never sends it in start payload.

### HTTP surface

```text
GET  /api/v1/projects/{projectId}/runs/active
GET  /api/v1/projects/{projectId}/runs?limit=20&cursor={opaqueCursor}
GET  /api/v1/projects/{projectId}/runs/{runId}
POST /api/v1/projects/{projectId}/runs
POST /api/v1/projects/{projectId}/runs/{runId}/stop
POST /api/v1/projects/{projectId}/runs/{runId}/log-ticket
```

```ts
export type ActiveRunResponse = { run: RunSummary | null };
export type RunListResponse = { items: RunSummary[]; nextCursor: string | null };
export type StartRunRequest = { expectedWorkspaceRevision: WorkspaceRevision };
export type LogTicketResponse = { ticket: LogTicket; expiresAt: string };
```

- `projectId` and `runId` use `encodeURIComponent`; cursor uses `URLSearchParams`。
- Start body accepts exactly one field. Extra command/image/resource/env fields are rejected by the mock contract.
- Start returns `202 RunSummary`; Stop returns `200 RunSummary` and is idempotent。
- Active returns the single locking Run or null; it never returns a terminal Run as active。
- Run detail confirms the terminal state when polling changes from a known active Run to null while its log socket is unavailable. A null active response alone never unlocks an already locked session。
- List is descending and deduplicated by `runId`; cursor is opaque, not parsed by browser。
- Ticket response never returns arbitrary WebSocket host/path. Client derives exact same-origin `/api/v1/ws/run-logs?ticket=...` from `window.location` and switches only `http -> ws` / `https -> wss`。

### New API errors

```ts
type Stage4ApiErrorCode =
  | 'RUN_ALREADY_ACTIVE'
  | 'RUN_STATE_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'LOG_TICKET_NOT_AVAILABLE';
```

- `RUN_ALREADY_ACTIVE` / `RUN_STATE_CONFLICT`：不信任错误文案推断状态，立即 refetch active。
- Start/Stop 网络错误具有“服务端可能已接受”的歧义，必须 refetch active 后再展示可重试动作。
- `RUN_NOT_FOUND`：对非 owned/unknown 资源仍由后端使用不泄漏存在性的 403；404 只用于已授权上下文中的过期历史引用。
- `LOG_TICKET_NOT_AVAILABLE`：不改变 Run lock；活动 Run 可按 backoff 重试，历史 Run 给显式 Retry。
- 所有 mutation `retry: false`；401 沿用当前 token 绑定 cleanup，旧 token 迟到 401 不清新会话。

## Run Authority State Machine

```text
LOADING_AUTHORITY
  -> EDITABLE (active=null, file revision ready)
  -> STARTING | RUNNING | STOPPING | RECOVERING (active Run)

EDITABLE
  -> START_REQUEST_PENDING (frontend fail-closed)
  -> STARTING (202/refetch authority)

STARTING -> RUNNING -> STOPPING -> CANCELLED
    |          |          |
    |          |          +----> FAILED
    |          +---------------> SUCCEEDED | FAILED | TIMED_OUT
    +----> STOPPING -----------> CANCELLED | FAILED
    +--------------------------> FAILED

STARTING | RUNNING | STOPPING
  -> RECOVERING
  -> locking state or terminal state

terminal state
  -> RELOADING_WORKSPACE
  -> EDITABLE
  -> RELOAD_FAILED (still locked, explicit Retry)
```

Rules:

- Initial active query pending/error is locked. “Cannot verify authority” is not editable。
- Start mutation pending locks before the 202 response so a concurrent write cannot begin through UI。
- A validated WebSocket locking-state event may update active query after matching project/run. A terminal event updates detail/history, invalidates active and triggers coordinator；the active cache never stores a terminal Run. Periodic active/detail queries remain reconciliation authority。
- Socket close/error/log completion does not transition Run or unlock。
- Client elapsed timer is display-only. At 30 minutes it cannot mark `TIMED_OUT` or unlock；server summary must do so。
- Navigating away/logout closes sockets and clears browser state but does not stop Run。Re-entry starts at `LOADING_AUTHORITY`。

### Project authority serialization

Rename the Stage 3 file mutation scope from `project-file-write:${projectId}` to:

```ts
scope: { id: `project-authority:${projectId}` }
```

Start and Stop use the same scope. This prevents same-project file writes and Run mutations from being sent concurrently. Backend revision/lock checks remain mandatory. Different projects retain independent scopes。

## Log Protocol Decisions

### Ticket and WebSocket URL

1. Browser sends authenticated HTTP `POST .../log-ticket`。
2. Server returns opaque single-use ticket expiring in about 30 seconds。
3. Browser constructs same-origin `ws(s)://<current-origin>/api/v1/ws/run-logs?ticket=<encoded>`。
4. Server consumes ticket during handshake；reuse、wrong user/project/run 或 expired ticket is rejected。
5. Once open, client sends one subscribe control frame with its last applied seq。

The main JWT never appears in the WebSocket URL. Ticket values must not be logged, rendered, persisted or reused。

### Client frame

```ts
export type LogClientFrame = {
  type: 'log.subscribe';
  lastSeq: number | null;
};
```

### Server frames

```ts
export type LogChunk = {
  seq: number;
  text: string;
  byteLength: number;
  persistedAt: string;
};

export type LogWindowMeta = {
  firstAvailableSeq: number | null;
  lastAvailableSeq: number | null;
  retainedBytes: number;
  truncated: boolean;
  evictedBytes: number;
};

export type LogStreamErrorCode =
  | 'TICKET_EXPIRED'
  | 'TICKET_USED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RUN_NOT_FOUND'
  | 'PROTOCOL_ERROR'
  | 'STREAM_UNAVAILABLE';

export type LogServerFrame =
  | { type: 'log.replay'; chunks: LogChunk[]; window: LogWindowMeta }
  | { type: 'log.append'; chunk: LogChunk; window: LogWindowMeta }
  | { type: 'run.state'; run: RunSummary }
  | { type: 'log.complete'; lastSeq: number | null }
  | { type: 'stream.heartbeat'; serverTime: string }
  | { type: 'stream.error'; code: LogStreamErrorCode; retryable: boolean };
```

Handshake failures use bounded application close codes because no JSON frame is guaranteed before `open`: `4401` unauthenticated, `4403` forbidden, `4408` ticket expired, `4409` ticket used and `1011` retryable server failure. Client ignores free-form close reason text. Expired/used obtains a fresh ticket；forbidden stops；unauthenticated obeys captured-token binding before cleanup。

### Sequence and byte rules

- `seq` is a positive safe integer, strictly increasing per Run. `lastSeq=null` means no applied chunk。
- Replay chunks are sorted and unique. A replay may begin above `lastSeq + 1` only when `firstAvailableSeq` proves earlier data was evicted and `truncated=true`。
- Append `seq <= lastAppliedSeq` is duplicate and ignored；`seq > lastAppliedSeq + 1` without valid truncation proof is a gap, so close and reconnect from last applied seq。
- `byteLength === new TextEncoder().encode(text).byteLength`；mismatch rejects the frame。
- `retainedBytes <= 5 * 1024 * 1024` and equals retained chunk bytes；`truncated=false` requires `evictedBytes=0`。
- Mock appends update the persisted window first, then send frame. This order is testable only as mock contract。
- Frame JSON has bounded size and chunk text is capped at 64 KiB UTF-8 in mock fixtures；a single oversized/invalid frame is rejected and stream reconnects without rendering partial content。

### Reconnect policy

- Each connection has monotonically increasing local generation；late events from closed generation are ignored。
- New connection always requests a fresh ticket and subscribes with last applied seq。
- Retry schedule uses injectable clock and bounded backoff `0 ms, 500 ms, 1 s, 2 s, 5 s` then remains at 5 s while active/selected；tests disable jitter for determinism。
- Ticket HTTP 401 uses existing current-token cleanup. A WebSocket `UNAUTHENTICATED` frame captures the access-token binding that created its ticket and may clear auth only if that token is still current；a stale socket from Alice cannot clear Bob. 403/non-retryable stream error stops retry；retryable close/error/heartbeat timeout reconnects。
- Heartbeat watchdog is 30 seconds while open；background timer throttling may delay reconnect but never unlocks or deletes logs。
- Selecting another history Run, project switch, logout, 401 or unmount closes the socket, clears timers, unregisters `ConnectionRegistry`, and advances generation。

## Run Log Store And Rendering

```ts
export type RunLogSnapshot = {
  projectId: string;
  runId: RunId;
  chunks: readonly LogChunk[];
  lastAppliedSeq: number | null;
  window: LogWindowMeta;
  connection: 'idle' | 'ticketing' | 'connecting' | 'replaying' | 'live' | 'reconnecting' | 'complete' | 'failed';
  pendingOutput: boolean;
  error: string | null;
};
```

- Store keys include project/run；Alice/Bob same `runId` cannot collide。
- Store retains raw text chunks and authoritative byte metadata, not one repeatedly concatenated 5 MiB string。
- Subscribers are notified at most once per animation frame or fixed test-injectable batch tick under burst output。
- Renderer joins visible chunks only on batched snapshot, uses React text content/`<pre>` semantics, never `dangerouslySetInnerHTML`。
- Auto-follow is based on scroll distance threshold。When user scrolls up, `pendingOutput=true` and no forced scroll；New output restores bottom。
- Switching panel preserves RunLogStore and scroll position；switching selected Run changes view and connection without merging chunks。
- Store is disposed on project switch/logout/401；history query may remain only within current authenticated Query cache。

## Workspace Reload Contract

When a locking Run becomes terminal:

1. Capture current `openPaths` and `activePath`; dirty must be zero by start contract。
2. Set coordinator to `RELOADING_WORKSPACE`; File UI stays visible/read-only with status。
3. Cancel all file queries and assert there is no pending/queued file mutation. Run start is forbidden while file writes are pending, and active Run lock forbids new writes；the reload flow must not pretend TanStack Query can cancel an already submitted mutation。
4. Dispose project buffers and Monaco models；remove project file queries including revision。
5. Reset/activate the project session and fetch fresh root tree。
6. For each previously open path, fetch fresh metadata then content if renderable；paths now missing/blocked are handled by authoritative response, not old cache。
7. Reopen surviving paths in original order and restore active path when still present；deleted paths remain closed。
8. Only after root and all reopened paths settle successfully, transition `EDITABLE`。

Any root/meta/content failure produces `RELOAD_FAILED` and remains locked. Retry repeats from a clean disposed state. User may navigate away/logout; these actions do not unlock the current mounted workbench or stop the server Run。

## Target File Structure

```text
poc4/frontend/src/
├─ api/
│  ├─ runApi.ts
│  └─ runApi.test.ts
├─ contracts/
│  ├─ api.ts
│  ├─ run.ts
│  ├─ run.test.ts
│  ├─ log.ts
│  └─ log.test.ts
├─ components/
│  ├─ runs/
│  │  ├─ RunPanel.tsx
│  │  ├─ RunPanel.test.tsx
│  │  ├─ RunToolbar.tsx
│  │  ├─ RunHistory.tsx
│  │  ├─ RunLogView.tsx
│  │  └─ StopRunDialog.tsx
│  ├─ files/
│  │  ├─ EditorWorkspace.tsx
│  │  └─ FileTree.tsx
│  └─ shell/
│     └─ WorkbenchShell.tsx
├─ features/
│  ├─ runs/
│  │  ├─ runQueries.ts
│  │  ├─ runQueries.test.ts
│  │  ├─ runMutations.ts
│  │  ├─ runMutations.test.ts
│  │  ├─ RunAuthorityCoordinator.ts
│  │  ├─ RunAuthorityCoordinator.test.ts
│  │  ├─ workspaceReload.ts
│  │  └─ workspaceReload.test.ts
│  ├─ logs/
│  │  ├─ logProtocol.ts
│  │  ├─ logProtocol.test.ts
│  │  ├─ RunLogStore.ts
│  │  ├─ RunLogStore.test.ts
│  │  ├─ RunLogTransport.ts
│  │  └─ RunLogTransport.test.ts
│  ├─ files/fileMutations.ts
│  └─ editor/runPreconditions.ts
├─ mocks/
│  ├─ runState.ts
│  ├─ runState.test.ts
│  ├─ runFixtures.ts
│  ├─ runHandlers.ts
│  ├─ runSocket.ts
│  └─ runSocket.test.ts
└─ runtime/ConnectionRegistry.ts

poc4/frontend/tests/e2e/
├─ stage4.spec.ts
└─ stage4-large-logs.spec.ts

poc4/docs/evidence/stage-4/
├─ result.md
└─ chrome/edge PNG evidence
```

Stage 0 `src/terminal/**`、`TerminalPanel`、echo server and xterm packages remain untouched regression artifacts. Do not delete them and do not import them into Stage 4 production modules。

## Task 1: Define Run, Log And Browser Boundary Contracts

**Files:**

- Modify: `poc4/frontend/scripts/browser-boundary-lib.mjs`
- Modify: `poc4/frontend/scripts/browser-boundary-lib.test.mjs`
- Modify: `poc4/frontend/scripts/check-browser-boundary.mjs`
- Modify: `poc4/frontend/src/contracts/api.ts`
- Create: `poc4/frontend/src/contracts/run.ts`
- Create: `poc4/frontend/src/contracts/run.test.ts`
- Create: `poc4/frontend/src/contracts/log.ts`
- Create: `poc4/frontend/src/contracts/log.test.ts`
- Create: `poc4/frontend/src/api/runApi.ts`
- Create: `poc4/frontend/src/api/runApi.test.ts`

- [ ] **Step 1: Write failing Stage 4 boundary tests**

Extend the durable production module classifier to `src/api/runApi.ts`、`src/contracts/run.ts`、`src/contracts/log.ts`、`src/features/runs/**`、`src/features/logs/**`、`src/components/runs/**` and modified shell/files modules. Reject imports from `src/terminal/**`、Stage 0 Spike、mocks、echo server、Node built-ins、Electron and physical/Kubernetes resource identifiers。

- [ ] **Step 2: Add production-string exclusions**

Include the exact Stage 4 mock scenario endpoint、mock ticket prefix、seed log marker and any mock-only persistence key in production output scans. Keep prior Stage 0-3 needles。

- [ ] **Step 3: Write table-driven Run parser tests**

Cover all states and invariants, invalid timestamps/order, wrong policy, negative/unsafe bytes or seq, duplicate history IDs, wrong sort, malformed cursor and unknown fields that would enable browser-supplied command/resources. One invalid item rejects the full response。

- [ ] **Step 4: Write log frame parser tests**

Cover every frame, exact UTF-8 byte length including Chinese/emoji, duplicate/out-of-order replay, invalid window bounds, retained bytes over 5 MiB, oversized chunk and mismatched project/run context supplied by caller。

- [ ] **Step 5: Implement exact Run HTTP API**

Add `getActiveRun`、`getRun`、`listRuns`、`startRun`、`stopRun`、`createLogTicket`. Assert encoded opaque IDs/cursor, exact methods/bodies, Bearer header, AbortSignal propagation and absence of JWT/command/image/resources in URL/body。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/contracts/run.test.ts src/contracts/log.test.ts src/api/runApi.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/scripts poc4/frontend/src/contracts poc4/frontend/src/api
git -C ../.. commit -m "feat(poc4): define stage 4 run and log contracts"
```

## Task 2: Build Deterministic Run And Persisted-Log Mock State

**Files:**

- Create: `poc4/frontend/src/mocks/runState.ts`
- Create: `poc4/frontend/src/mocks/runState.test.ts`
- Create: `poc4/frontend/src/mocks/runFixtures.ts`
- Modify: `poc4/frontend/src/mocks/state.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/handlers.test.ts`

- [ ] **Step 1: Write failing state-machine tests**

Test valid transitions、one active Run/project、independent projects、start revision match、duplicate start、stop idempotency、timeout/failure/success/cancel、history sort/pagination and terminal not returned as active. Invalid transition must leave state/log/revision unchanged。

- [ ] **Step 2: Model server-owned policy and exact start payload**

Mock start accepts only `expectedWorkspaceRevision`. It creates `STARTING` with fixed POC4 policy. Extra command/image/resource/env fields return validation error. This proves contract shape, not Kubernetes enforcement。

- [ ] **Step 3: Implement persisted log windows**

Append chunks with increasing seq, compute UTF-8 bytes, cap individual chunk at 64 KiB and evict oldest whole chunks until retained bytes <= 5 MiB. Increment cumulative `evictedBytes` and update Run summary metadata before notifying socket subscribers。

- [ ] **Step 4: Add deterministic scenario clock**

Inject clock/timers so tests drive STARTING -> RUNNING -> terminal, STOPPING -> CANCELLED, heartbeat and delayed append without real sleeps. Browser mock may use timers only behind mock imports。

- [ ] **Step 5: Add mock-only refresh persistence**

Persist only compact mock scenario/active summary/small-log seed in an explicitly named mock-only `sessionStorage` key so E2E refresh can rehydrate active Run and a small replay cursor. Never persist real auth token、production buffers or the >5 MiB stress payload；the large-log case tests socket reconnect without page refresh. Reset helper clears the key between tests。

- [ ] **Step 6: Add Stage 4 scenario endpoint**

One authenticated mock-only endpoint configures success/failure/timeout/recovery/delayed-start/gap/disconnect/large-log/reload-change scenarios. It must not exist in production dist and must not be used by product code。

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test -- src/mocks/handlers.test.ts src/mocks/runState.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/mocks
git -C ../.. commit -m "test(poc4): model authoritative runs and log windows"
```

## Task 3: Implement Mock HTTP Tickets And MSW WebSocket Stream

**Files:**

- Create: `poc4/frontend/src/mocks/runHandlers.ts`
- Create: `poc4/frontend/src/mocks/runSocket.ts`
- Create: `poc4/frontend/src/mocks/runSocket.test.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/browser.ts`
- Modify: `poc4/frontend/src/mocks/node.ts`
- Modify: `poc4/frontend/src/test/setup.ts`

- [ ] **Step 1: Write owner/READY/revision/active handler tests**

Every endpoint requires current Bearer user and owned READY project. Unknown/non-owned returns the same generic 403. Start checks revision and active state; file writes continue returning `PROJECT_LOCKED` while active。

- [ ] **Step 2: Implement one-time ticket registry**

Ticket record binds user ID、project ID、run ID、expiry and used flag. Tests cover wrong owner/run、expiry、reuse and reset cleanup. Never expose JWT in ticket record evidence or output。

- [ ] **Step 3: Implement `ws.link()` same-origin handler**

Use MSW 2 WebSocket API for `/api/v1/ws/run-logs`. Consume ticket during connection, require exactly one valid subscribe frame, replay persisted gap, then send live append/state/heartbeat. Invalid protocol closes without sending partial log data。

- [ ] **Step 4: Prove persist-before-send ordering**

Instrument mock state so socket tests assert each emitted append already exists in persisted window and replay after forced disconnect returns it. Label this mock ordering only。

- [ ] **Step 5: Implement deterministic fault scenarios**

Support gap、duplicate、socket close、retryable/non-retryable error、ticket expiry and heartbeat silence. Do not introduce a separate local WebSocket server or reuse `scripts/echo-ws.mjs`。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/mocks/runSocket.test.ts src/mocks/handlers.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/mocks poc4/frontend/src/test/setup.ts
git -C ../.. commit -m "test(poc4): stream replayable mock run logs"
```

## Task 4: Implement Run Queries, Mutations And Authority Bootstrap

**Files:**

- Create: `poc4/frontend/src/features/runs/runQueries.ts`
- Create: `poc4/frontend/src/features/runs/runQueries.test.ts`
- Create: `poc4/frontend/src/features/runs/runMutations.ts`
- Create: `poc4/frontend/src/features/runs/runMutations.test.ts`
- Create: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.ts`
- Create: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.test.ts`
- Modify: `poc4/frontend/src/features/files/fileMutations.ts`
- Modify: `poc4/frontend/src/features/files/fileMutations.test.ts`
- Modify: `poc4/frontend/src/features/editor/runPreconditions.ts`
- Modify: `poc4/frontend/src/features/editor/runPreconditions.test.ts`

- [ ] **Step 1: Write active/history query tests**

Active/detail keys are project-scoped and retry only transient network/5xx with bounded policy；never retry 401/403. While active, poll every 5 seconds even with healthy socket for reconciliation. When a previously active Run disappears, fetch its detail and require a parsed terminal state before reload. History uses cursor pages and immutable dedupe/sort。

- [ ] **Step 2: Replace Stage 3 unavailable precondition**

`canRequestRun=true` only when authority loaded with no active Run、dirty zero、write pending false、revision available and reload phase editable. Preserve explicit reason priority and accessible descriptions。

- [ ] **Step 3: Unify project mutation scope**

Change file save/CRUD and start/stop to `project-authority:${projectId}`. Tests prove same project serializes and different projects do not. Normal UI never queues Start behind a pending file write. If a bypass creates that race, Start keeps the revision captured at user intent；a preceding write therefore causes authoritative revision conflict and explicit retry, never a silent start with a newer revision。

- [ ] **Step 4: Implement start with ambiguity reconciliation**

Start mutation uses `retry:false`, sets frontend pending lock, sends exact revision and accepts only parsed 202. On network/409, refetch active before exposing Retry. Never optimistically invent a Run ID/state。

- [ ] **Step 5: Implement idempotent stop**

Stop targets current active `runId`, confirms selection at execution, and remains pending until authoritative response/refetch. It never writes `CANCELLED` locally and never unlocks on error。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/runs src/features/editor/runPreconditions.test.ts src/features/files/fileMutations.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features
git -C ../.. commit -m "feat(poc4): coordinate authoritative project runs"
```

## Task 5: Implement Log Protocol, Store And Reconnecting Transport

**Files:**

- Create: `poc4/frontend/src/features/logs/logProtocol.ts`
- Create: `poc4/frontend/src/features/logs/logProtocol.test.ts`
- Create: `poc4/frontend/src/features/logs/RunLogStore.ts`
- Create: `poc4/frontend/src/features/logs/RunLogStore.test.ts`
- Create: `poc4/frontend/src/features/logs/RunLogTransport.ts`
- Create: `poc4/frontend/src/features/logs/RunLogTransport.test.ts`
- Modify: `poc4/frontend/src/runtime/ConnectionRegistry.test.ts`

- [ ] **Step 1: Write protocol and sequence tests first**

Cover replay from null/lastSeq、duplicate ignore、valid truncation jump、invalid gap、malformed JSON、oversized frame、UTF-8 mismatch、wrong Run event、complete and heartbeat. Parser returns typed all-or-nothing frames。

- [ ] **Step 2: Build project/run-scoped external store**

Implement immutable snapshots over chunk arrays without full text per append. Apply authoritative window metadata, evict by `firstAvailableSeq`, maintain last applied seq and batch notifications with injectable scheduler。

- [ ] **Step 3: Build same-origin URL and ticket lifecycle**

Only accept current page `http/https` origin and fixed path. Encode opaque ticket once. Register close with `ConnectionRegistry`; ticketing/connecting/open/close/dispose are idempotent。

- [ ] **Step 4: Implement generation-safe reconnect**

Fresh ticket per attempt, lastSeq subscribe, bounded backoff, heartbeat watchdog, offline/online handling and stale generation rejection. Ticket 401 cleanup goes through `HttpClient`; WebSocket unauthenticated events use the captured current-token binding before cleanup；403/non-retryable stops with explicit error。

- [ ] **Step 5: Update Run query from validated state frames**

Only matching project/run state frames can set/invalidate active/detail/history queries. Locking states may set active；terminal states update detail/history and invalidate active before triggering coordinator, never direct editor unlock. Socket error/close never mutates active Run。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/logs src/runtime/ConnectionRegistry.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/logs poc4/frontend/src/runtime
git -C ../.. commit -m "feat(poc4): replay and reconnect run logs"
```

## Task 6: Build The Run Panel And Log Interaction

**Files:**

- Create: `poc4/frontend/src/components/runs/RunPanel.tsx`
- Create: `poc4/frontend/src/components/runs/RunPanel.test.tsx`
- Create: `poc4/frontend/src/components/runs/RunToolbar.tsx`
- Create: `poc4/frontend/src/components/runs/RunHistory.tsx`
- Create: `poc4/frontend/src/components/runs/RunLogView.tsx`
- Create: `poc4/frontend/src/components/runs/StopRunDialog.tsx`
- Modify: `poc4/frontend/src/styles/globals.css`

- [ ] **Step 1: Write the component state matrix**

Cover authority loading/error、editable Start、every Run state、start/stop pending、history empty/loading/error/page、ticketing/replay/live/reconnecting/complete/failure、truncated and reload failure。

- [ ] **Step 2: Build compact toolbar and state summary**

Show state text/icon、fixed command、elapsed/finished time and policy values without cards. Start is enabled only by preconditions. Stop is enabled only for `STARTING/RUNNING`; `STOPPING/RECOVERING` remain visibly locked/waiting. Stop opens confirmation with Cancel focus。

- [ ] **Step 3: Build recent Run list**

Use a fixed-width unframed side region inside Run panel, semantic list/buttons, full timestamp/state accessible labels and Load more cursor action. Active/new Run auto-selects unless user explicitly selected history。

- [ ] **Step 4: Build log viewer with controlled auto-follow**

Render text safely in a scroll container. Follow only near bottom；scroll-up preserves position and exposes New output. Keep truncation banner and evicted byte count visible without covering log text。

- [ ] **Step 5: Add keyboard and live-region behavior**

Tab order matches toolbar -> history -> logs -> New output. Avoid announcing every log chunk；announce only connection/status transitions and errors. Reduced motion disables smooth scrolling。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/runs
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components/runs poc4/frontend/src/styles/globals.css
git -C ../.. commit -m "feat(poc4): add run and log workbench panel"
```

## Task 7: Enforce Run Lock Across The Writable Workbench

**Files:**

- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/components/files/EditorWorkspace.tsx`
- Modify: `poc4/frontend/src/components/files/EditorWorkspace.test.tsx`
- Modify: `poc4/frontend/src/components/files/WritableMonacoEditor.tsx`
- Modify: `poc4/frontend/src/components/files/PlainTextEditor.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.test.tsx`
- Modify: `poc4/frontend/src/features/projects/WorkbenchPage.tsx`

- [ ] **Step 1: Keep File and Run mounted across panel switches**

Replace the permanently selected File tab with controlled panel state. Both panels remain mounted；inactive panel uses `inert`、`aria-hidden` and non-interactive visibility without changing layout, so it cannot receive focus or shortcuts. Terminal remains disabled and unmounted。

- [ ] **Step 2: Gate before mounting writable controls**

Workbench starts at `LOADING_AUTHORITY`. Until active query resolves, editor and CRUD are locked or withheld. Query error remains locked with Retry；never fall through to editable。

- [ ] **Step 3: Apply lock to every write surface**

Monaco `readOnly/domReadOnly` update, plain textarea readonly, Save/New/Rename/Delete disabled, dirty close Save disabled when locked. Existing buffer text remains visible but no edit is accepted。

- [ ] **Step 4: Preserve read operations and navigation**

File tree expansion、tab selection、download、Run/log viewing、back/logout remain usable. Leaving/logging out closes client sockets but does not call Stop。Re-enter restores authority via GET active。

- [ ] **Step 5: Prove backend redundancy in mock handlers**

Direct PUT/CRUD during active Run returns `409 PROJECT_LOCKED` even if component lock is bypassed. Start with dirty/write pending or stale revision is independently rejected。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/shell/WorkbenchShell.test.tsx src/components/files/EditorWorkspace.test.tsx src/components/files/FileTree.test.tsx src/features/projects
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components poc4/frontend/src/features/projects
git -C ../.. commit -m "feat(poc4): lock workspace from run authority"
```

## Task 8: Force Workspace Reload Before Unlock

**Files:**

- Create: `poc4/frontend/src/features/runs/workspaceReload.ts`
- Create: `poc4/frontend/src/features/runs/workspaceReload.test.ts`
- Modify: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.ts`
- Modify: `poc4/frontend/src/features/runs/RunAuthorityCoordinator.test.ts`
- Modify: `poc4/frontend/src/features/files/fileQueries.ts`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/runs/RunPanel.tsx`
- Modify: `poc4/frontend/src/mocks/runState.ts`

- [ ] **Step 1: Write reload ordering tests**

Assert capture paths -> lock -> cancel -> dispose buffers/models -> remove queries/revision -> root fetch -> metadata-first content fetch -> reopen -> unlock. Use deferred promises to prove no early unlock。

- [ ] **Step 2: Handle container-side file changes in mock scenario**

At terminal transition, mock may modify an open file, add one file and delete another before terminal summary, then advances the workspace revision before exposing the terminal state. Reload tests must observe the new revision/content/tree and close the missing tab. Label all of this as simulated Job side effect。

- [ ] **Step 3: Handle mode and path outcomes**

Previously open file can become BLOCKED or missing；do not restore stale Monaco. Surviving tabs preserve order and active selection where possible, without preserving old view state/content as authority。

- [ ] **Step 4: Fail closed and retry from scratch**

Root/meta/content failure enters `RELOAD_FAILED`, all write surfaces stay locked, and Retry repeats clean sequence. Back/logout remain available and do not mark reload successful。

- [ ] **Step 5: Reconcile terminal events from query and socket once**

Deduplicate terminal transition by runId/state generation so simultaneous polling and WebSocket events do not run reload twice or dispose a new project session。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/runs/workspaceReload.test.ts src/features/runs/RunAuthorityCoordinator.test.ts src/features/files/fileQueries.test.ts src/components/shell/WorkbenchShell.test.tsx
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features poc4/frontend/src/components poc4/frontend/src/mocks/runState.ts
git -C ../.. commit -m "feat(poc4): reload workspace after terminal runs"
```

## Task 9: Harden Reconnect, History And Session Cleanup

**Files:**

- Modify: `poc4/frontend/src/features/logs/RunLogTransport.ts`
- Modify: `poc4/frontend/src/features/logs/RunLogTransport.test.ts`
- Modify: `poc4/frontend/src/features/logs/RunLogStore.ts`
- Modify: `poc4/frontend/src/features/logs/RunLogStore.test.ts`
- Modify: `poc4/frontend/src/components/runs/RunPanel.test.tsx`
- Modify: `poc4/frontend/src/app/appRuntime.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/test/renderApp.tsx`

- [ ] **Step 1: Test reconnect transition matrix**

Cover close before open、close after replay、gap、duplicate、heartbeat timeout、offline/online、ticket 401/403/expiry、non-retryable error、terminal complete and selected history change. Assert ticket counts、lastSeq and timers。

- [ ] **Step 2: Register all connection resources globally**

Logout/current-token 401 closes sockets/timers before query clear/auth clear. Stale token 401 cannot close the new user's stream. `closeAll()` still attempts every closer after one throws。

- [ ] **Step 3: Isolate active and historical logs**

At most one selected Run socket per workbench. Switching selection closes old connection and advances generation；returning uses retained lastSeq or fresh replay according to store policy, never merges text。

- [ ] **Step 4: Reconcile refresh persistence honestly**

E2E refresh rehydrates mock state via mock-only storage, then active GET locks before editor. Evidence must say this proves browser recovery contract, not backend restart/MySQL persistence。

- [ ] **Step 5: Keep history cleanup claim bounded**

Mock excludes records older than seven days and paginates remaining records, but Stage 4 report must state real scheduled deletion is unverified until Stage 6。

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/logs src/components/runs/RunPanel.test.tsx src/app/appRuntime.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/logs poc4/frontend/src/components/runs poc4/frontend/src/app poc4/frontend/src/test
git -C ../.. commit -m "fix(poc4): harden run log recovery and cleanup"
```

## Task 10: Add Browser, Visual And Real 5 MiB Log Evidence

**Files:**

- Create: `poc4/frontend/tests/e2e/stage4.spec.ts`
- Create: `poc4/frontend/tests/e2e/stage4-large-logs.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-4/chrome-run-1280x720.png`
- Create: `poc4/docs/evidence/stage-4/chrome-run-1440x900.png`
- Create: `poc4/docs/evidence/stage-4/chrome-run-1920x1080.png`
- Create: `poc4/docs/evidence/stage-4/chrome-truncated-log-1280x720.png`
- Create: `poc4/docs/evidence/stage-4/chrome-truncated-log-1440x900.png`
- Create: `poc4/docs/evidence/stage-4/chrome-truncated-log-1920x1080.png`
- Create: matching six Edge PNG files

- [ ] **Step 1: Add Stage 4 functional E2E**

At minimum cover:

1. initial active authority loads before editing becomes available；
2. dirty/write pending/revision missing prevents POST；
3. Start sends exact revision/no command and locks File；
4. duplicate start and network ambiguity reconcile active；
5. Run panel switches without losing dirty/log state；
6. replay -> live ordered logs and persisted-before-replay after reconnect；
7. duplicate ignored、gap gets fresh ticket/replay、stale socket ignored；
8. Stop dialog Cancel and idempotent Stop -> STOPPING -> CANCELLED；
9. socket close does not unlock；
10. success/failure/timeout each trigger forced reload before edit；
11. reload changed/added/deleted files and reload failure Retry；
12. refresh/re-entry restores active lock and log cursor；
13. history pagination and selected-run isolation；
14. logout/current 401 closes stream, stale 401 does not clear new user；
15. Terminal remains disabled and no terminal endpoint/frame occurs。

- [ ] **Step 2: Add dedicated large-log project**

Create `chromium-large-logs` with 180-second timeout and only `stage4-large-logs.spec.ts`. Stream at least `5 MiB + 1 MiB` actual UTF-8 payload in <=64 KiB chunks, force eviction, disconnect midstream, append while disconnected, reconnect/replay and complete. Record generated bytes、retained bytes、evicted bytes、frame count、ready time、reconnect catch-up time、console/page errors and responsiveness probe。

- [ ] **Step 3: Assert large-log correctness**

Require retained bytes <=5 MiB, truncation visible, first/last seq correct, no duplicate markers, latest marker visible, evicted marker absent, page responsive and auto-follow behavior stable. Metadata-only fake size is forbidden。

- [ ] **Step 4: Add Chrome/Edge screenshots and geometry assertions**

Capture active Run and truncated log at 1280x720、1440x900、1920x1080. Assert toolbar/history/log/Stop/Terminal tab reachability、no document overflow、no sidebar/log overlap、state and truncation not clipped、log contains non-background text pixels。

- [ ] **Step 5: Add keyboard/accessibility assertions**

Keyboard-only File -> Run -> Start -> history -> log -> New output -> Stop dialog Cancel/Confirm. Assert focus return、visible focus、status/error announcement and reduced-motion scroll。

- [ ] **Step 6: Update scripts and README**

Add `test:e2e:large-logs` using pnpm. README describes Stage 4 mock-only authority/log contract, ticket security, 5 MiB behavior, forced reload and explicit exclusions: real Job/MySQL/Kubernetes/backend restart/terminal。

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test:e2e
pnpm test:e2e:large-logs
pnpm test:e2e:channels
git -C ../.. diff --check
git -C ../.. add poc4/frontend/tests poc4/frontend/playwright.config.ts poc4/frontend/package.json poc4/frontend/README.md poc4/docs/evidence/stage-4
git -C ../.. commit -m "test(poc4): verify stage 4 run and logs"
```

Channel runs may recapture prior PNGs. Restore only verified prior-stage recaptures after inspecting paths；do not touch `.grok/` or user files。

## Task 11: Final Verification And Stage 4 Evidence Report

**Files:**

- Create: `poc4/docs/evidence/stage-4/result.md`

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
```

Record source SHA、command、exit code、exact test counts and duration. Rebuild production after mock/E2E before scanning dist。

- [ ] **Step 2: Scan production output and dependency boundary**

Require zero matches for all prior needles plus Stage 4 scenario/ticket/persistence/log markers. Confirm no `stage0.html`/MSW worker、entry remains free of Monaco/Run heavy modules、Run production modules contain no terminal/xterm/echo/mock import and no physical/Kubernetes resource names。

- [ ] **Step 3: Record authority and lock evidence**

Document initial authority、start/stop request shapes、revision、state transitions、ambiguity reconciliation、file write rejection、socket-close non-unlock and terminal reload ordering. Redact tokens/tickets。

- [ ] **Step 4: Record log protocol and recovery evidence**

List replay/live seq traces、ticket counts、disconnect gap、duplicate/gap/stale generation behavior、heartbeat、logout cleanup and history isolation. Distinguish mock persisted state from MySQL proof。

- [ ] **Step 5: Record real-byte performance and visuals**

Include actual generated/retained/evicted UTF-8 bytes、chunk count、timings、browser version、console/page errors、responsiveness checks and all PNG dimensions/1280 geometry assertions。

- [ ] **Step 6: Record unresolved real-system evidence**

Explicitly list unverified real Spring Boot auth、MySQL transaction/5 MiB/7-day cleanup、Kubernetes one-Job lock、fixed command/resources/30-minute timeout、Pod log ordering and backend restart recovery. These are not Stage 4 failures because this plan is the frontend migration stage, but remain mandatory for Stage 6。

- [ ] **Step 7: Verify repository hygiene**

```powershell
git -C ../.. diff --check
git -C ../.. status --short
```

Strictly decode tracked text under `poc4/frontend` and `poc4/docs` as UTF-8, report BOM/CR counts under current line-ending policy, and exclude `.grok/`、worktrees、traces、videos、reports and prior-stage recaptures。

- [ ] **Step 8: Make the decision**

Only when all 15 exit gates pass, write:

```text
READY_FOR_STAGE_5_PLAN
```

Otherwise write:

```text
STAGE_4_REMEDIATION_REQUIRED
```

List each failed gate and do not start Stage 5 planning。

- [ ] **Step 9: Commit the report**

```powershell
git -C ../.. add poc4/docs/evidence/stage-4/result.md poc4/frontend/README.md
git -C ../.. commit -m "docs(poc4): record stage 4 run and logs result"
```

## Verification Matrix

| Layer | Required evidence |
|---|---|
| Contracts | Run invariants、exact start/stop/ticket HTTP、log frame/byte/window parsers |
| Mock authority | owner/READY/revision/one-active/state transition/idempotent stop |
| Mock persistence | append persisted before send、5 MiB eviction、history/cursor、refresh rehydrate |
| Query/mutation | bootstrap fail-closed、poll reconciliation、shared scope、no optimistic terminal state |
| Transport | fresh ticket、same-origin URL、generation、backoff、heartbeat、cleanup |
| Log store | replay/live、dedupe/gap、bounded chunks、batching、project/run isolation |
| UI | File/Run mounted、lock、Start/Stop、history、truncation、auto-follow、a11y |
| Reload | dispose/remove/refetch/reopen order、changed/added/deleted files、failure lock |
| Browsers | Chromium regression、Chrome/Edge core + 12 Stage 4 screenshots |
| Stress | real >6 MiB stream、retained <=5 MiB、disconnect catch-up、responsive page |
| Production | mock/ticket/scenario/echo/Spike/terminal import zero、lazy split retained |
| Hygiene | tests/build/diff/UTF-8/BOM/scoped clean status |

## Acceptance Traceability

| POC4 rule | Stage 4 proof | Still deferred |
|---|---|---|
| Unsaved blocks run | Start preconditions + direct mock rejection | Real backend revision transaction |
| One active Job/project | Active contract + duplicate start mock | Real Kubernetes/MySQL distributed lock |
| Fixed Maven command/resources/30 min | Start body excludes client policy; server-owned summary | Actual Job spec and timeout enforcement |
| Run-time editing locked | Authority bootstrap/state/reload lock + 409 writes | Real backend active Run lock |
| Start/stop/failure/timeout | Full browser state transitions | Real Job lifecycle |
| Logs persisted then pushed | Mock ordering + replay after disconnect | Real MySQL-before-WebSocket transaction |
| Latest 5 MiB | Real browser byte stream/window/truncation | Real database eviction and storage load |
| Refresh/disconnect recovery | active GET + fresh ticket + lastSeq replay | Backend restart recovery |
| Seven-day history | Mock list/expiry contract | Real scheduled cleanup |
| Terminal | Disabled/no endpoint | Entire Stage 5 |

## Known Risks Carried Forward

1. **真实后端/Kubernetes 仍是最大风险。** Mock 状态机无法证明 Job、Pod log、MySQL、锁和资源限制的真实行为。
2. **HTTP 与 WebSocket 双权威事件可能竞态。** Run summary 必须完整验证并按相同 Run reconcile；终态 reload 需要 generation 去重。
3. **Start/Stop 网络错误具有提交歧义。** 自动重试可能创建重复意图，因此必须 refetch active，而不是重放 mutation。
4. **5 MiB 文本仍会产生内存放大。** Chunk store、React render text and WebSocket frame can coexist；压力测试是机器证据，不是 SLA。
5. **浏览器后台节流影响心跳/轮询。** Cached active state保持锁定可避免误解锁，但恢复速度可能变慢。
6. **终态与最后日志到达顺序。** UI 不能以 socket complete 解锁；历史 replay必须能补齐最终窗口。
7. **强制 reload 可能关闭用户打开路径。** Missing/blocked files must follow server state；失败保持锁定可能需要用户重试或离开。
8. **MSW refresh persistence is artificial.** SessionStorage rehydrate only enables browser contract tests, not backend restart evidence。
9. **Stage 5 terminal must remain separate.** Reusing log transport for PTY would mix protocols and lifecycle, creating audit/security errors。

## Rollback Boundaries

- Contract/mock failure：回退 Task 1-3，Stage 3 可写工作台保持可用。
- Authority/transport failure：回退 Task 4-5，不启用 Run tab。
- UI/lock failure：回退 Task 6-7；不得只移除 lock tests 放行。
- Reload failure：回退 Task 8 and keep terminal states locked；不得直接解锁陈旧文件。
- Recovery/E2E failure：修复 Task 9-10，不降低 5 MiB actual-byte、Chrome/Edge or production scan gates。

不得通过乐观标记 terminal、socket close 解锁、把 ticket 当 JWT、提高 Vite warning limit、缩小压力载荷、跳过真实 channel 浏览器或导入 Stage 0 terminal 来获得绿色结果。

## Execution Start Condition

执行前必须：

1. 确认 Stage 3 merge `d375407` 或其后继提交位于目标基线，Stage 3 decision 为 `READY_FOR_STAGE_4_PLAN`。
2. 本计划经过用户确认并提交到 `master`。
3. 从该提交创建隔离工作树和 `codex/poc4-stage-4-run-logs` 分支。
4. 保持 EnsoAI 来源 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；Stage 4 只延续既有 shell/theme/icons，不复制 EnsoAI 本机 PTY 或 Electron Run 逻辑。
5. 保留 `.grok/` 未跟踪目录，不修改、不提交。
6. 执行只从 Task 1 开始；完成后停在 `READY_FOR_STAGE_5_PLAN` 决策门，不自动实现终端或真实后端。
