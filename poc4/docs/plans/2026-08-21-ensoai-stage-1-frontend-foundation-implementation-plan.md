# EnsoAI Stage 1 Frontend Foundation Implementation Plan

> **Execution rule:** Implement this plan task by task in an isolated worktree. Use TDD for behavior changes, pnpm for all frontend package operations, and small commits after each task.

**Goal:** 在阶段 0 浏览器 Spike 基线上，完成 POC4 的前端路由、固定测试账号登录、短期 JWT 会话、项目列表、项目创建状态和统一错误处理，并用可控 HTTP mock 证明前端状态机正确。

**Architecture:** 阶段 1 仍是纯浏览器前端，不创建 Spring Boot、MySQL、PVC、Pod 或 Kubernetes 资源。React Router 负责页面边界，TanStack Query 负责项目服务端状态，短期 JWT 仅保存在内存会话中，统一 `HttpClient` 负责 Bearer Header 与 401 失效处理。MSW 只在开发 mock 模式和自动化测试中启用，生产构建必须排除 mock 凭据、handler 和阶段 0 echo 入口。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、React Router 8.3.0、TanStack Query 5.101.4、MSW 2.15.0、Vitest、Testing Library、Playwright、Tailwind CSS 4。

**Current documentation checked on 2026-08-21:** React Router 官方文档确认 `createBrowserRouter`、`RouterProvider`、`Navigate`、`Outlet` 和 location state 可用于 library/data mode；TanStack Query v5 官方文档确认 `QueryClientProvider`、`useQuery`、`useMutation`、`invalidateQueries` 和函数式 `refetchInterval`；MSW 2 官方文档确认 `http`、`HttpResponse`、`setupServer`、browser worker 与测试后的 `resetHandlers()` 生命周期。

---

## 0. Scope And Non-Negotiable Boundaries

### Included

- `/login`、`/projects`、`/projects/:projectId` 和 404 路由。
- 固定测试账号登录，短期 access token 仅驻留内存。
- 受保护路由、登录后回到原始站内路径、显式退出。
- `GET /api/v1/projects`、`POST /api/v1/projects`、`GET /api/v1/projects/{projectId}` 的前端契约。
- 项目 `CREATING`、`READY`、`FAILED` 三态和创建期间轮询。
- 每用户最多 3 个项目的 UI 与 mock API 双重约束。
- `401` 清理会话、Query Cache 和连接注册表后返回登录页。
- `403` 不泄露资源存在性；网络错误与后端错误有稳定、可重试的 UI。
- Chrome、Edge 和 Chromium 的登录、项目创建、状态转换与 JWT 失效测试。

### Explicitly excluded

- 真实 Spring Boot/JWT/MySQL 实现。
- 真实项目所有权安全证明。
- PVC、工作区 Pod、Maven 模板初始化和失败资源回收。
- 文件树、文件读取、Monaco 真实项目模型和显式保存。
- Run、日志、真实 PTY、ticket、命令审计和 Kubernetes。
- refresh token、浏览器持久化登录、项目删除、重试创建、分页和搜索。

### Security interpretation

MSW 只证明浏览器面对 `200/202/401/403/409/5xx` 时的行为，不证明后端授权成立。阶段 1 证据报告必须使用“mock contract verified”，不得写“所有权隔离已验证”。真实跨用户拒绝访问只能在主后端实现和真实集群验收后声明。

### Stage 1 exit gate

只有以下条件全部满足，阶段 1 才结束：

1. 未认证访问受保护路由必定重定向 `/login`。
2. 登录成功后 token 只存在内存，不写入 `localStorage`、`sessionStorage`、URL 或日志。
3. 任意 API `401` 只触发一次全局退出，清空 Query Cache 和连接注册表。
4. 项目列表完整展示空、加载、错误、`CREATING`、`READY`、`FAILED` 和 3 项目上限状态。
5. `CREATING` 自动轮询，`READY` 才允许进入项目路由，`FAILED` 显示后端原因。
6. `403` 使用通用拒绝文案，不推断项目是否存在。
7. 生产构建不包含 MSW worker、mock 密码、`127.0.0.1:4174` 或阶段 0 页面入口。
8. Chromium、真实 Chrome 和真实 Edge 核心 E2E 通过，1280 px 无重叠和不可达操作。

## 1. Target File Structure

```text
poc4/frontend/
├─ .env.mock
├─ stage0.html
├─ public-mock/
│  └─ mockServiceWorker.js
├─ src/
│  ├─ main.tsx
│  ├─ stage0-main.tsx
│  ├─ app/
│  │  ├─ AppProviders.tsx
│  │  ├─ AppRouter.tsx
│  │  ├─ appRuntime.ts
│  │  ├─ appRuntime.test.ts
│  │  └─ queryClient.ts
│  ├─ api/
│  │  ├─ ApiRequestError.ts
│  │  ├─ httpClient.ts
│  │  ├─ httpClient.test.ts
│  │  ├─ authApi.ts
│  │  └─ projectApi.ts
│  ├─ contracts/
│  │  ├─ api.ts
│  │  ├─ auth.ts
│  │  └─ project.ts
│  ├─ components/
│  │  ├─ feedback/AppErrorBoundary.tsx
│  │  ├─ feedback/AccessDeniedPage.tsx
│  │  ├─ feedback/InlineAlert.tsx
│  │  ├─ feedback/LoadingState.tsx
│  │  ├─ feedback/NotFoundPage.tsx
│  │  ├─ ui/input.tsx
│  │  └─ ui/spinner.tsx
│  ├─ features/
│  │  ├─ auth/
│  │  │  ├─ AuthProvider.tsx
│  │  │  ├─ authSession.ts
│  │  │  ├─ authSession.test.ts
│  │  │  ├─ LoginPage.tsx
│  │  │  ├─ LoginPage.test.tsx
│  │  │  └─ RequireAuth.tsx
│  │  └─ projects/
│  │     ├─ projectQueries.ts
│  │     ├─ ProjectsPage.tsx
│  │     ├─ ProjectsPage.test.tsx
│  │     ├─ ProjectCard.tsx
│  │     ├─ CreateProjectForm.tsx
│  │     └─ ProjectRoutePage.tsx
│  ├─ mocks/
│  │  ├─ browser.ts
│  │  ├─ handlers.ts
│  │  ├─ handlers.test.ts
│  │  ├─ node.ts
│  │  └─ state.ts
│  ├─ runtime/
│  │  ├─ ConnectionRegistry.ts
│  │  └─ ConnectionRegistry.test.ts
│  ├─ spike/
│  │  └─ Stage0SpikeApp.tsx
│  └─ test/
│     ├─ renderApp.tsx
│     └─ setup.ts
├─ tests/e2e/
│  ├─ spike.spec.ts
│  └─ stage1.spec.ts
└─ docs are written under poc4/docs/evidence/stage-1/
```

`Zustand` is deliberately deferred. Stage 1 has only one small ephemeral auth session; introducing a general client store now adds no useful behavior. Stage 2 can introduce Zustand when editor tabs, expanded directories and active panel state need a shared browser-session store. TanStack Query remains the only owner of project server state.

## Task 1: Close The Remaining Stage 0 Review Findings

**Files:**

- Modify: `poc4/frontend/src/components/shell/WorkbenchSpike.tsx`
- Modify: `poc4/frontend/src/components/terminal/TerminalPanel.tsx`
- Modify: `poc4/frontend/tests/e2e/spike.spec.ts`
- Modify: `poc4/docs/evidence/stage-0/result.md`

- [ ] **Step 1: Add a failing inactive-terminal shortcut test**

Change `TerminalPanel` to accept `active: boolean`. Add an E2E case that starts on File, dispatches a cancelable `Ctrl+F`, switches to Terminal, and proves the terminal search input did not open while Terminal was inactive.

Required assertions:

```ts
expect(dispatched.defaultPrevented).toBe(false);
await page.getByRole('tab', { name: 'Terminal' }).click();
await expect(page.getByPlaceholder('Search...')).toHaveCount(0);
```

Run:

```powershell
pnpm exec playwright test --project=chromium --grep "inactive terminal"
```

Expected: FAIL because the always-mounted terminal currently owns the global shortcut.

- [ ] **Step 2: Scope the global shortcut to the active panel**

`WorkbenchSpike` passes `active={activePanel === 'terminal'}`. `TerminalPanel` registers the global key listener only when `active` is true, or returns before calling `preventDefault()` when inactive. Existing WebSocket and xterm instances remain mounted and connected.

Run the targeted E2E again. Expected: PASS; switching panels still preserves one open terminal socket.

- [ ] **Step 3: Correct screenshot evidence wording**

Replace byte-identity claims in `result.md` with visual invariants: correct dimensions, nonblank Monaco canvas, no overlap, no overflow and reachable controls. State explicitly that PNG bytes may vary due to browser rendering timing and are not golden-file assertions.

- [ ] **Step 4: Verify and commit**

```powershell
pnpm test
pnpm test:e2e
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components poc4/frontend/tests/e2e/spike.spec.ts poc4/docs/evidence/stage-0/result.md
git -C ../.. commit -m "fix(poc4): scope terminal shortcuts to active panel"
```

## Task 2: Add The Stage 1 Application Skeleton And Dependencies

**Files:**

- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/pnpm-lock.yaml`
- Modify: `poc4/frontend/vite.config.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/src/main.tsx`
- Delete: `poc4/frontend/src/App.tsx`
- Delete: `poc4/frontend/src/App.css`
- Delete: `poc4/frontend/src/index.css`
- Delete: `poc4/frontend/src/assets/react.svg`
- Delete: `poc4/frontend/public/vite.svg`
- Create: `poc4/frontend/stage0.html`
- Create: `poc4/frontend/src/stage0-main.tsx`
- Create: `poc4/frontend/src/spike/Stage0SpikeApp.tsx`
- Create: `poc4/frontend/src/app/AppProviders.tsx`
- Create: `poc4/frontend/src/app/AppRouter.tsx`
- Create: `poc4/frontend/src/app/queryClient.ts`
- Create: `poc4/frontend/.env.mock`
- Create: `poc4/frontend/public-mock/mockServiceWorker.js`

- [ ] **Step 1: Add exact dependencies with pnpm**

```powershell
pnpm add --save-exact react-router@8.3.0 @tanstack/react-query@5.101.4
pnpm add --save-dev --save-exact msw@2.15.0
pnpm exec msw init public-mock --save
```

Do not use npm. Confirm `package.json` records the MSW worker directory and no dependency adds Electron or Node PTY. Configure Vite with `publicDir: mode === 'mock' ? 'public-mock' : 'public'`; otherwise Vite would copy the mock worker into the normal production build.

The build input must follow this shape:

```ts
export default defineConfig(({ mode }) => {
  const mockMode = mode === 'mock';
  return {
    publicDir: mockMode ? 'public-mock' : 'public',
    build: {
      rollupOptions: {
        input: mockMode
          ? {
              app: fileURLToPath(new URL('./index.html', import.meta.url)),
              stage0: fileURLToPath(new URL('./stage0.html', import.meta.url)),
            }
          : fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  };
});
```

Merge this with the existing React, Tailwind, alias, target and sourcemap configuration; do not replace those settings.

- [ ] **Step 2: Split the accepted Spike from the production application**

Move the existing Spike composition behind `stage0.html` and `stage0-main.tsx`. The production `index.html` renders only the Stage 1 router. Vite uses multi-page input only in `mock` mode; the normal production build has only `index.html`.

Update the existing Spike E2E to navigate to `/stage0.html`. Keep the echo server only for those regression tests.

- [ ] **Step 3: Add deterministic scripts**

Required scripts:

```json
{
  "dev": "vite --port 4173",
  "dev:mock": "vite --mode mock --port 4173",
  "build": "pnpm typecheck && vite build",
  "build:mock": "pnpm typecheck && vite build --mode mock"
}
```

`.env.mock` contains only:

```dotenv
VITE_ENABLE_MOCK_API=true
VITE_ENABLE_STAGE0_PAGE=true
```

- [ ] **Step 4: Create provider and router roots**

`AppProviders` owns the single `QueryClient` and authentication provider. `AppRouter` declares `/login`, protected `/projects`, protected `/projects/:projectId`, root redirect and wildcard page. Use `createBrowserRouter` and `RouterProvider`; do not adopt the React Router framework Vite plugin.

- [ ] **Step 5: Verify production exclusion**

```powershell
pnpm build
rg -n "mockServiceWorker|demo-pass|127\.0\.0\.1:4174|stage0\.html" dist
```

Expected: build exits 0 and `rg` exits 1 with no matches.

- [ ] **Step 6: Commit**

```powershell
git -C ../.. add poc4/frontend
git -C ../.. commit -m "chore(poc4): scaffold stage 1 frontend application"
```

## Task 3: Define Contracts, Connection Cleanup And HTTP Semantics

**Files:**

- Create: `poc4/frontend/src/contracts/api.ts`
- Create: `poc4/frontend/src/contracts/auth.ts`
- Create: `poc4/frontend/src/contracts/project.ts`
- Create: `poc4/frontend/src/api/ApiRequestError.ts`
- Create: `poc4/frontend/src/api/httpClient.ts`
- Create: `poc4/frontend/src/api/httpClient.test.ts`
- Create: `poc4/frontend/src/api/authApi.ts`
- Create: `poc4/frontend/src/api/projectApi.ts`
- Create: `poc4/frontend/src/runtime/ConnectionRegistry.ts`
- Create: `poc4/frontend/src/runtime/ConnectionRegistry.test.ts`

- [ ] **Step 1: Lock the public contract types**

Use these exact shapes:

```ts
export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PROJECT_LIMIT_REACHED'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR';

export type ApiErrorBody = {
  code: ApiErrorCode;
  message: string;
  traceId: string;
};

export type LoginRequest = { username: string; password: string };
export type AuthUser = { id: string; username: string };
export type LoginResponse = {
  accessToken: string;
  expiresAt: string;
  user: AuthUser;
};

export type ProjectState = 'CREATING' | 'READY' | 'FAILED';
export type ProjectSummary = {
  id: string;
  name: string;
  state: ProjectState;
  createdAt: string;
  failureReason: string | null;
};
export type ProjectListResponse = { items: ProjectSummary[]; limit: 3 };
export type CreateProjectRequest = { name: string };
```

No contract may contain PVC, Pod, Job, namespace, physical path or Kubernetes identifiers.

- [ ] **Step 2: Write failing HTTP client tests**

Cover:

- Relative `/api/v1/...` URL only.
- `Authorization: Bearer <token>` when authenticated.
- No authorization header for login.
- JSON success parsing and `204` handling.
- Structured `ApiRequestError` on non-2xx.
- Exactly one unauthorized callback per response.
- Generic network error without claiming a save or mutation succeeded.

- [ ] **Step 3: Implement the minimal client**

Constructor dependencies:

```ts
type HttpClientOptions = {
  getAccessToken(): string | null;
  onUnauthorized(): void;
  fetchImpl?: typeof fetch;
};
```

Reject absolute URLs in the client API. Preserve `status`, parsed error body and `traceId` in `ApiRequestError`. Do not retry mutations automatically.

- [ ] **Step 4: Implement connection cleanup**

`ConnectionRegistry.register(close)` returns an unregister function. `closeAll()` invokes each registered closer once, clears the set and tolerates one closer throwing so remaining connections still close. Stage 1 has no production WebSocket yet, but 401 handling depends on this contract for later log and terminal streams.

- [ ] **Step 5: Add thin auth and project APIs**

Only these functions are exported:

```ts
login(request: LoginRequest): Promise<LoginResponse>;
listProjects(): Promise<ProjectListResponse>;
createProject(request: CreateProjectRequest): Promise<ProjectSummary>;
getProject(projectId: string): Promise<ProjectSummary>;
```

Encode `projectId` with `encodeURIComponent`. Components never call `fetch` directly.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/api/httpClient.test.ts src/runtime/ConnectionRegistry.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src/api poc4/frontend/src/contracts poc4/frontend/src/runtime
git -C ../.. commit -m "feat(poc4): define stage 1 browser API contracts"
```

## Task 4: Implement Ephemeral Authentication And Protected Routes

**Files:**

- Create: `poc4/frontend/src/features/auth/authSession.ts`
- Create: `poc4/frontend/src/features/auth/authSession.test.ts`
- Create: `poc4/frontend/src/features/auth/AuthProvider.tsx`
- Create: `poc4/frontend/src/features/auth/RequireAuth.tsx`
- Create: `poc4/frontend/src/features/auth/LoginPage.tsx`
- Create: `poc4/frontend/src/features/auth/LoginPage.test.tsx`
- Create: `poc4/frontend/src/components/ui/input.tsx`
- Modify: `poc4/frontend/src/app/AppProviders.tsx`
- Modify: `poc4/frontend/src/app/AppRouter.tsx`
- Create: `poc4/frontend/src/app/appRuntime.ts`

- [ ] **Step 1: Test the auth session before implementation**

Test anonymous initial state, successful authentication, explicit logout, absolute expiry timer, duplicate clear idempotence and no browser storage writes. Use fake timers for expiry.

The session is a small observable object with:

```ts
type AuthSnapshot =
  | { status: 'anonymous'; reason: 'initial' | 'logout' | 'expired' | 'unauthorized' }
  | { status: 'authenticated'; accessToken: string; expiresAt: string; user: AuthUser };
```

- [ ] **Step 2: Create the application runtime once**

`appRuntime.ts` creates one auth session, one QueryClient, one ConnectionRegistry and one HttpClient. Its unauthorized callback runs in this order:

1. `connectionRegistry.closeAll()`.
2. `queryClient.clear()`.
3. `authSession.clear('unauthorized')`.

The operation must be idempotent when several requests return 401 together.

- [ ] **Step 3: Implement route guards**

`RequireAuth` redirects anonymous users to `/login` with `replace` and location state `{ from: pathname }`. After login, accept only the location state created by the router; never accept a URL query as an arbitrary redirect target.

Authenticated users visiting `/login` redirect to `/projects`.

- [ ] **Step 4: Implement the login page**

Requirements:

- Username and password inputs with explicit labels.
- Password never logged, persisted or placed in URL state.
- Submit disabled while pending and when either input is blank.
- Invalid credentials show `role="alert"` without echoing the password.
- Network error remains on the page and allows retry.
- Success stores the response in memory and replaces history with the protected target.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test -- src/features/auth
pnpm typecheck
pnpm build
git -C ../.. add poc4/frontend/src/app poc4/frontend/src/features/auth poc4/frontend/src/components/ui/input.tsx
git -C ../.. commit -m "feat(poc4): add ephemeral authentication and route guards"
```

## Task 5: Build Deterministic MSW Authentication And Project Lifecycles

**Files:**

- Create: `poc4/frontend/src/mocks/state.ts`
- Create: `poc4/frontend/src/mocks/handlers.ts`
- Create: `poc4/frontend/src/mocks/handlers.test.ts`
- Create: `poc4/frontend/src/mocks/browser.ts`
- Create: `poc4/frontend/src/mocks/node.ts`
- Modify: `poc4/frontend/src/test/setup.ts`
- Modify: `poc4/frontend/src/main.tsx`

- [ ] **Step 1: Define isolated mock state**

Provide two fixed mock users only in `src/mocks/state.ts`. Use obviously synthetic credentials such as `alice / demo-pass` and `bob / demo-pass`; never reuse an environment or real credential. Tokens are opaque mock strings mapped to user IDs.

Each user starts with private projects. Project IDs are opaque (`prj-...`) and handler authorization is derived only from the Bearer token.

- [ ] **Step 2: Implement handlers**

Required behavior:

- Login success returns a 15-minute expiry.
- Invalid login returns `401 UNAUTHENTICATED`.
- Missing, expired or unknown token returns `401`.
- Listing returns only the authenticated owner's projects.
- Project detail owned by another user returns the same generic `403 FORBIDDEN` as an inaccessible ID.
- Fourth project creation returns `409 PROJECT_LIMIT_REACHED`.
- Normal creation returns `202` with `CREATING`, then becomes `READY` after two project queries.
- A name beginning with `fail-` becomes `FAILED` with a deterministic mock reason after two queries.

- [ ] **Step 3: Wire MSW lifecycles**

Vitest setup:

```ts
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetMockState();
});
afterAll(() => server.close());
```

Browser worker starts only when `VITE_ENABLE_MOCK_API === 'true'`, before React renders. Normal production must not start or import it.

- [ ] **Step 4: Test handler ownership and transitions**

Use direct fetch tests to prove Alice cannot read Bob's project, list results are owner-filtered, creation transitions exactly once and the fourth project is rejected by the mock server even if UI controls are bypassed.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test -- src/mocks
pnpm build
pnpm build:mock
git -C ../.. add poc4/frontend/src/mocks poc4/frontend/src/test/setup.ts poc4/frontend/src/main.tsx poc4/frontend/public-mock/mockServiceWorker.js
git -C ../.. commit -m "test(poc4): add stage 1 browser API simulation"
```

## Task 6: Implement Project Queries, List, Creation And Status Gate

**Files:**

- Create: `poc4/frontend/src/features/projects/projectQueries.ts`
- Create: `poc4/frontend/src/features/projects/ProjectsPage.tsx`
- Create: `poc4/frontend/src/features/projects/ProjectsPage.test.tsx`
- Create: `poc4/frontend/src/features/projects/ProjectCard.tsx`
- Create: `poc4/frontend/src/features/projects/CreateProjectForm.tsx`
- Create: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`
- Create: `poc4/frontend/src/components/feedback/InlineAlert.tsx`
- Create: `poc4/frontend/src/components/feedback/LoadingState.tsx`
- Create: `poc4/frontend/src/components/ui/spinner.tsx`
- Create: `poc4/frontend/src/test/renderApp.tsx`
- Modify: `poc4/frontend/src/app/AppRouter.tsx`

- [ ] **Step 1: Define stable query keys and polling**

```ts
export const projectKeys = {
  all: ['projects'] as const,
  detail: (projectId: string) => ['projects', projectId] as const,
};
```

List and detail queries use `retry: false`. Their TanStack Query v5 `refetchInterval` callback reads `query.state.data`, returns `1000` only while any visible project is `CREATING`, and otherwise returns `false`. Creating a project inserts or invalidates the list and starts polling without optimistic `READY` state.

- [ ] **Step 2: Test every project state**

Component tests cover:

- Loading skeleton with stable dimensions.
- Empty state and create form.
- `CREATING` card with spinner and disabled open action.
- `READY` card with enabled open action.
- `FAILED` card with backend reason and no open action.
- Exactly 3 projects disables creation before submission.
- `409 PROJECT_LIMIT_REACHED` remains correctly handled if UI is bypassed.
- List network failure has retry action and does not discard auth.

- [ ] **Step 3: Implement the project list UI**

Use an operational layout: compact top bar with current username and logout icon/button, page title, inline new-project form, and a scan-friendly project list. Cards may represent individual projects but must not be nested inside another card. Minimum width remains 1280 px.

Project names are trimmed, 1-64 characters, and submitted as display names only. Do not derive filesystem or Kubernetes names in the browser.

- [ ] **Step 4: Implement the project route state gate**

`/projects/:projectId` performs a detail query:

- `CREATING`: show provisioning state and continue polling.
- `FAILED`: show the backend reason and a back-to-projects action.
- `READY`: show a quiet project-ready shell with project name and status, but do not render the Stage 0 echo terminal or pretend that files are loaded.
- `403`: show generic access denied and a back action.
- Any inaccessible or unknown opaque project ID: show the same generic unavailable/access-denied state without guessing existence.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test -- src/features/projects
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src/features/projects poc4/frontend/src/components/feedback poc4/frontend/src/components/ui/spinner.tsx poc4/frontend/src/test/renderApp.tsx poc4/frontend/src/app/AppRouter.tsx
git -C ../.. commit -m "feat(poc4): add project lifecycle frontend"
```

## Task 7: Add Global Error, Logout And Unauthorized Recovery

**Files:**

- Create: `poc4/frontend/src/components/feedback/AppErrorBoundary.tsx`
- Create: `poc4/frontend/src/components/feedback/NotFoundPage.tsx`
- Create: `poc4/frontend/src/components/feedback/AccessDeniedPage.tsx`
- Modify: `poc4/frontend/src/app/AppProviders.tsx`
- Modify: `poc4/frontend/src/app/AppRouter.tsx`
- Create: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/features/projects/ProjectsPage.test.tsx`

- [ ] **Step 1: Test concurrent 401 handling**

Arrange two active cached queries and two registered connection closers. Return two concurrent `401` responses. Assert:

- Both closers run exactly once.
- Query cache becomes empty.
- Auth becomes anonymous with reason `unauthorized`.
- Router replaces the current page with `/login`.
- Login page shows one expired-session message, not duplicate alerts.

- [ ] **Step 2: Implement explicit logout through the same cleanup path**

Logout closes connections, clears Query Cache and clears auth with reason `logout`. Do not retain project data for the next user in memory.

- [ ] **Step 3: Add render and route error boundaries**

Unexpected render errors show a stable full-page recovery view with reload action. Expected API errors remain local to their page. Never display stack traces, JWTs, passwords or raw response bodies in the browser.

- [ ] **Step 4: Verify and commit**

```powershell
pnpm test -- src/app src/features/auth src/features/projects src/components/feedback
pnpm typecheck
pnpm build
git -C ../.. add poc4/frontend/src
git -C ../.. commit -m "feat(poc4): centralize frontend session failure recovery"
```

## Task 8: Add Production-Build E2E And Visual Evidence

**Files:**

- Create: `poc4/frontend/tests/e2e/stage1.spec.ts`
- Modify: `poc4/frontend/tests/e2e/spike.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Create: twelve PNG files under `poc4/docs/evidence/stage-1/`

- [ ] **Step 1: Run E2E against the mock production build**

Playwright webServer uses `pnpm build:mock && pnpm preview --host 127.0.0.1`. Keep the echo server because `spike.spec.ts` still validates the accepted xterm Spike.

- [ ] **Step 2: Implement the Stage 1 workflow tests**

Required test cases:

1. `/projects` redirects to `/login` when anonymous.
2. Invalid login stays on login and exposes one alert.
3. Valid login returns to the original protected path or `/projects`.
4. Create project shows `CREATING`, then `READY`, then allows project route navigation.
5. `fail-...` project reaches `FAILED` and displays the deterministic reason.
6. Three projects disable creation; bypassed fourth request returns the limit error.
7. Forced `401` clears cached projects and redirects to login; exact connection-closer behavior remains an `appRuntime` integration test because Stage 1 has no production stream registered from the UI.
8. Bob's project produces generic access denied for Alice.
9. Logout followed by Bob login never shows Alice's cached projects.
10. Stage 0 inactive Terminal no longer intercepts File-panel `Ctrl+F`.

Do not use fixed sleeps. Observe accessible status text and use Playwright auto-waiting or `expect.poll`.

- [ ] **Step 3: Add visual captures**

Capture login and populated projects pages in Chrome and Edge at:

- 1280 x 720
- 1440 x 900
- 1920 x 1080

Before capture, wait for `document.fonts.ready`, disable CSS animations and hide text carets. Assert dimensions, no horizontal overflow, no panel overlap, visible primary actions and no clipped project state labels. PNG hashes are not acceptance criteria.

- [ ] **Step 4: Verify all browser suites**

```powershell
pnpm test:e2e
pnpm test:e2e:channels
```

Expected: all Stage 0 and Stage 1 workflows pass in Chromium; all core workflows and twelve captures pass in installed Chrome and Edge.

- [ ] **Step 5: Commit**

```powershell
git -C ../.. add poc4/frontend/tests poc4/frontend/playwright.config.ts poc4/docs/evidence/stage-1
git -C ../.. commit -m "test(poc4): verify stage 1 frontend workflows"
```

## Task 9: Final Verification And Stage 1 Evidence Report

**Files:**

- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-1/result.md`

- [ ] **Step 1: Replace the Vite template README**

Document only working commands and boundaries:

- `pnpm dev:mock`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:boundary`
- `pnpm build`
- `pnpm build:mock`
- `pnpm test:e2e`
- `pnpm test:e2e:channels`
- Synthetic mock credentials and the statement that they are not real backend credentials.
- Stage 1 frontend-only boundary and known 4.8 MB bundle issue.

- [ ] **Step 2: Run the final command matrix on one exact commit**

```powershell
pnpm test:boundary
pnpm typecheck
pnpm test
pnpm build
pnpm build:mock
pnpm test:e2e
pnpm test:e2e:channels
```

After browser tests:

```powershell
git -C ../.. diff --check
git -C ../.. status --short
```

Expected: all commands exit 0; only intentional evidence files are changed before the report commit.

- [ ] **Step 3: Verify production exclusions and encoding**

```powershell
rg -n "demo-pass|mockServiceWorker|127\.0\.0\.1:4174|stage0\.html" dist
```

Expected: no matches. Scan tracked text files as strict UTF-8, confirm no BOM, and honor repository line-ending policy.

- [ ] **Step 4: Write the evidence report**

`result.md` must contain:

```markdown
# EnsoAI Stage 1 Frontend Foundation Result

## Source Commit
## Scope Boundary
## Automated Verification
## Authentication Evidence
## Project Lifecycle Evidence
## Browser And Visual Evidence
## Production Exclusion Evidence
## Known Gaps
## Decision
## Confidence
```

The decision is `READY_FOR_STAGE_2_PLAN` only if every Stage 1 exit-gate item passes. Otherwise use `STAGE_1_REMEDIATION_REQUIRED` and list the failed item. Never claim real backend authorization, PVC creation or Kubernetes integration from MSW evidence.

- [ ] **Step 5: Commit the report**

```powershell
git -C ../.. add poc4/frontend/README.md poc4/docs/evidence/stage-1/result.md
git -C ../.. commit -m "docs(poc4): record stage 1 frontend foundation result"
git -C ../.. status --short
```

## Acceptance Traceability

| Required behavior | Primary implementation | Primary proof |
|---|---|---|
| Anonymous users cannot enter projects | `RequireAuth.tsx` | Router component test + Playwright redirect |
| JWT remains ephemeral | `authSession.ts` | Storage-spy unit test + production scan |
| 401 performs complete logout | `appRuntime.ts` | Concurrent-401 integration test |
| Project ownership is not inferred client-side | `projectApi.ts` and generic 403 page | Alice/Bob MSW contract test |
| Project limit is 3 | `CreateProjectForm.tsx` and MSW handler | UI plus bypassed-request test |
| CREATING reaches READY or FAILED | `projectQueries.ts` | Fake handler transitions + browser workflow |
| READY alone opens project route | `ProjectRoutePage.tsx` | State-gate component and E2E tests |
| Mock code stays out of production | Vite mode split | `pnpm build` artifact scan |
| Hidden Terminal has no global shortcut effects | active prop on `TerminalPanel` | inactive-terminal E2E |
| Browser layout remains usable | Stage 1 route pages | Chrome/Edge viewport assertions |

## Known Risks Carried Forward

- 真实 JWT 签名、密码哈希、用户所有权和 MySQL 模型未验证。
- 真实项目创建的 PVC/Pod 状态可能比 mock 更慢、更复杂，并需要后端幂等与失败回收。
- Access token 仅在内存，刷新页面会回到登录页；这是 POC 的显式选择，不是 refresh-token 实现遗漏。
- 主包约 4.8 MB；阶段 1 应利用路由懒加载降低登录和项目页首屏成本，但 Monaco Worker 和语言包优化仍需单独计量。
- 阶段 0 xterm 继续只作为独立 Spike 页面存在，不能被当成真实 Job 终端。
- MSW 的跨用户拒绝测试只验证前端契约与 mock handler，不替代真实后端对抗性测试。

## Execution Start Condition

实施前创建新的隔离 worktree 和 `codex/poc4-stage-1-frontend-foundation` 分支。基线必须是包含阶段 0 的 `c13e0c9` 或其后仅有文档计划提交的 `master`。若 `poc4/frontend` 在实施前出现其他未合并修改，先重新对照本计划文件清单，不覆盖用户改动。
