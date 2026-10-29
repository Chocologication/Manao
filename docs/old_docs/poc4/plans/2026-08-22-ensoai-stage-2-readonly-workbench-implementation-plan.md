# EnsoAI Stage 2 Read-Only Workbench Implementation Plan

> **Execution rule:** Implement task by task in a new isolated worktree. Use TDD for behavior changes, pnpm for every package operation, small focused patches, and one focused commit per task.

**Goal:** 在阶段 1 的认证与项目生命周期基础上，交付 EnsoAI 风格的只读项目工作台：懒加载文件树、多标签只读 Monaco、20/50 MiB 大小分级、二进制与超限文件阻断和受认证下载，同时保持 POC4 的相对路径与浏览器边界。

**Architecture:** TanStack Query 继续独占服务端状态，包括目录、metadata 和文件内容；Zustand 只保存不持久化的工作台会话状态，包括当前项目、展开目录、选中文件、打开标签和活动标签。文件打开严格执行 `tree -> metadata -> content`，只有服务端 metadata 判为 `MONACO_TEXT` 或 `PLAIN_TEXT` 时才请求正文。生产项目路由懒加载工作台和 Monaco；阶段 0 Spike 继续留在 mock-only `stage0.html`，不进入生产入口。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、React Router 8.3.0、TanStack Query 5.101.4、Zustand 5.0.15、Monaco Editor 0.55.1、MSW 2.15.0、Vitest、Testing Library、Playwright、Tailwind CSS 4。

**Current documentation checked on 2026-08-22:** Zustand v5 官方文档确认 TypeScript curried `create<T>()(...)`、selector 和 `getInitialState()` reset 模式；Monaco 官方文档确认 Vite ESM Worker、URI 唯一模型、`readOnly` 和 dispose 生命周期；TanStack Query v5 官方文档确认层级 query keys、`enabled` 懒查询、`staleTime`、`retry` 和对象式 `removeQueries`。Monaco 保持阶段 0 已验证的 0.55.1，不在本阶段顺带升级到 0.56.0。

---

## Scope And Non-Negotiable Boundaries

### Included

- `READY` 项目的生产只读工作台。
- EnsoAI 风格的紧凑 Shell、约 256 px 左侧文件树和右侧文件查看区。
- 根目录与展开目录的按需读取；隐藏文件默认显示。
- 多标签、切换、关闭、排序、选中同步和活动标签滚入视图。
- metadata-first 加载，以及 `MONACO_TEXT`、`PLAIN_TEXT`、`BLOCKED` 三种显示模式。
- 普通文本和 20 MiB 以内 Markdown 使用只读 Monaco。
- 20–50 MiB Markdown 使用只读纯文本查看器，不创建 Monaco model。
- 二进制、非 UTF-8 和超过策略上限的文件不请求正文、不进入 Monaco，只显示 metadata 和下载动作。
- 带 JWT 的 Blob 下载、object URL 创建与回收。
- 项目切换、logout 和 401 时清理工作台状态、文件 Query Cache 和 Monaco models。
- mock API、单元/组件测试、Chromium/Chrome/Edge E2E、视觉证据和实际大文件浏览器验证。

### Explicitly excluded

- 真实 Spring Boot、MySQL、PVC、工作区 Pod 或 Kubernetes 文件代理。
- 保存、`Ctrl+S`、dirty、workspace revision 写入、新建、重命名或删除。
- 文件监听、自动刷新、拖拽、上传、Git decoration、搜索和右键 CRUD 菜单。
- Run、日志、生产终端、WebSocket ticket 和命令审计。
- Markdown 预览、图片预览、十六进制查看器和浏览器内 PDF 预览。
- 同项目多标签页并发编辑、离线缓存和工作台状态持久化。

### Security interpretation

- 前端相对路径检查只用于拒绝明显错误输入和避免传播不可信响应，不能替代后端规范化、symlink escape 和所有权校验。
- MSW 只证明 **mock contract verified**；不得据此声称真实 PVC 文件隔离、真实路径逃逸防护或真实下载授权成立。
- 合同和 UI 中不得出现 PVC、Pod、Job、ServiceAccount、Namespace、本机绝对路径或 Kubernetes 资源名。
- 浏览器不能自行根据扩展名放宽文件大小；`renderMode`、`blockReason`、`sizeBytes` 和编码判断由服务端 metadata 决定。

### UI and accessibility guardrails

- Preserve the accepted EnsoAI density, theme tokens and existing system typography. Do not adopt a marketing/landing layout, vibrant block palette, oversized headings or decorative cards.
- Use Lucide icons already present in the project. Icon-only commands require tooltips, accessible names and fixed hit boxes.
- Tree and tab order must match visual order; focus rings remain visible and no keyboard trap is allowed in Monaco, the tree or the plain-text viewer.
- Add a visually hidden-until-focused `Skip to editor` link before the tree/navigation region.
- Async tree, metadata, content and download operations show local loading/error feedback. Errors use `role="alert"`; successful passive status uses `role="status"`.
- Hover feedback uses color/opacity only, not scale that moves dense controls. Respect `prefers-reduced-motion` for tab indicators and scrolling.

### Stage 2 exit gate

只有以下条件全部满足，阶段 2 才结束：

1. 所有文件 API 只接收通过验证的项目内正斜杠相对路径；根目录只用空字符串表示。
2. 初次进入只请求根目录；目录只有在展开时请求一次，折叠和重新展开使用同项目缓存。
3. 隐藏文件可见；目录优先、名称稳定排序；无 Git、拖拽、上传或写操作入口。
4. 打开文件先请求 metadata；`BLOCKED` 文件正文请求数为零，绕过 UI 请求正文也被 mock API 拒绝。
5. `MONACO_TEXT` 使用唯一、项目隔离的 model URI 和 `readOnly`；`PLAIN_TEXT` 不创建 Monaco model。
6. 普通文本 20 MiB 上限、Markdown 20/50 MiB 分级、二进制和非 UTF-8 行为均有边界值测试。
7. 关闭标签 dispose 对应 model；项目切换、logout 和当前会话 401 清空全部工作台状态、文件缓存与相关 models。
8. 受认证下载不会把 JWT 放入 URL，object URL 在触发后回收，文件名来自已验证 metadata。
9. 生产构建不包含 MSW worker、mock 凭据、mock expire 路径、echo URL 或 `stage0.html`；生产项目路由可加载 Monaco Worker。
10. Chromium、真实 Chrome 和真实 Edge 的核心工作流通过，1280 px 无重叠、裁切或不可达操作；大文件用例使用真实字节量并单独记录。
11. Keyboard-only navigation reaches the tree, tabs, viewer and Download; skip link, focus rings, `role="alert"` and reduced-motion behavior are covered.

## Contract Decisions

### Project-relative paths

```ts
declare const projectRelativePathBrand: unique symbol;

export type ProjectRelativePath = string & {
  readonly [projectRelativePathBrand]: true;
};

export type ProjectDirectoryPath = ProjectRelativePath | '';
```

`parseProjectRelativePath(value, { allowRoot })` accepts forward-slash paths only. It rejects leading slash, backslash, Windows drive prefix, UNC form, NUL, empty segments, `.` and `..`. It does not decode percent text; `URLSearchParams` performs transport encoding so a literal `%2e%2e` filename cannot become traversal by client-side double decoding.

### Read-only file contracts

```ts
export type FileTreeEntry = {
  path: ProjectRelativePath;
  name: string;
  kind: 'file' | 'directory';
  hidden: boolean;
  sizeBytes: number | null;
  hasChildren: boolean | null;
};

export type FileTreeResponse = {
  directory: ProjectDirectoryPath;
  entries: FileTreeEntry[];
};

export type FileRenderMode = 'MONACO_TEXT' | 'PLAIN_TEXT' | 'BLOCKED';
export type FileBlockReason =
  | 'BINARY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_ENCODING';

export type FileMetadata = {
  path: ProjectRelativePath;
  name: string;
  sizeBytes: number;
  mediaType: string;
  encoding: 'UTF-8' | null;
  language: string;
  renderMode: FileRenderMode;
  blockReason: FileBlockReason | null;
};

export type FileContentResponse = {
  path: ProjectRelativePath;
  content: string;
  workspaceRevision: string;
};
```

Metadata invariants are validated at the API boundary. `BLOCKED` requires a non-null reason and null encoding for binary/unsupported encoding. `MONACO_TEXT` and `PLAIN_TEXT` require UTF-8 and null block reason. Directory responses are rejected if an entry escapes the requested project-relative directory.

### HTTP surface

```text
GET /api/v1/projects/{projectId}/files/tree?path={relativeDirectory}
GET /api/v1/projects/{projectId}/files/meta?path={relativeFile}
GET /api/v1/projects/{projectId}/files/content?path={relativeFile}
GET /api/v1/projects/{projectId}/files/download?path={relativeFile}
```

All four routes require Bearer authentication. `projectId` uses `encodeURIComponent`; `path` is added with `URLSearchParams`. The download endpoint is a Stage 2 contract elaboration required by `poc4/docs/plan.md` for files that cannot be previewed. It returns bytes plus a safe server filename, never a physical path.

## Target File Structure

```text
poc4/frontend/src/
├─ api/
│  ├─ fileApi.ts
│  ├─ fileApi.test.ts
│  └─ httpClient.ts
├─ contracts/
│  ├─ api.ts
│  └─ file.ts
├─ components/
│  ├─ files/
│  │  ├─ FileTreeNode.tsx
│  │  ├─ ReadonlyFileTree.tsx
│  │  ├─ ReadonlyFileTree.test.tsx
│  │  ├─ ReadonlyEditorWorkspace.tsx
│  │  ├─ ReadonlyEditorWorkspace.test.tsx
│  │  ├─ ReadonlyMonacoEditor.tsx
│  │  ├─ PlainTextViewer.tsx
│  │  ├─ BlockedFileView.tsx
│  │  └─ downloadFile.ts
│  └─ shell/
│     ├─ WorkbenchShell.tsx
│     └─ WorkbenchShell.test.tsx
├─ features/
│  ├─ editor/
│  │  ├─ editorTypes.ts
│  │  ├─ workspaceSession.ts
│  │  └─ workspaceSession.test.ts
│  ├─ files/
│  │  ├─ fileQueries.ts
│  │  ├─ fileQueries.test.ts
│  │  ├─ pathPolicy.ts
│  │  └─ pathPolicy.test.ts
│  └─ projects/
│     ├─ ProjectRoutePage.tsx
│     └─ ReadonlyWorkbenchPage.tsx
├─ lib/
│  ├─ languageForFile.ts
│  ├─ projectMonacoModels.ts
│  └─ projectMonacoModels.test.ts
├─ mocks/
│  ├─ fileFixtures.ts
│  ├─ handlers.ts
│  ├─ handlers.test.ts
│  └─ state.ts
└─ test/
   └─ renderApp.tsx

poc4/frontend/src/runtime/
├─ ConnectionRegistry.ts
├─ WorkspaceResourceRegistry.ts
└─ WorkspaceResourceRegistry.test.ts

poc4/frontend/tests/e2e/
├─ stage1.spec.ts
├─ stage2.spec.ts
└─ stage2-large-files.spec.ts

poc4/docs/evidence/stage-2/
├─ result.md
└─ chrome/edge workbench PNG evidence
```

The Stage 0 `MonacoPanel.tsx`, `WorkbenchSpike.tsx`, terminal classes and echo server remain isolated regression artifacts. Production Stage 2 code may reuse `EditorTabs`, `fileIcons`, `monacoSetup`, theme tokens and general layout density, but must not import `mockFiles`, `TerminalPanel` or `WebSocketTerminalTransport`.

## Task 1: Add Zustand And Lock The Stage 2 Browser Boundary

**Files:**

- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/pnpm-lock.yaml`
- Modify: `poc4/frontend/scripts/browser-boundary-lib.mjs`
- Modify: `poc4/frontend/scripts/browser-boundary-lib.test.mjs`
- Modify: `poc4/frontend/scripts/check-browser-boundary.mjs`

- [ ] **Step 1: Add the exact Zustand dependency**

```powershell
pnpm add --save-exact zustand@5.0.15
```

Do not add persistence middleware configuration. Stage 2 state must disappear on reload, logout and project switch.

- [ ] **Step 2: Write failing production-import boundary tests**

Extend the boundary checker with an explicit Stage 2 production module set: `src/api/fileApi.ts`, `src/contracts/file.ts`, `src/features/files/**`, `src/features/editor/workspaceSession.ts`, `src/features/projects/ReadonlyWorkbenchPage.tsx`, `src/components/files/Readonly*`, `src/components/files/FileTreeNode.tsx` and `src/components/shell/WorkbenchShell.tsx`. At minimum reject these imports from that set:

```text
@/spike/*
@/terminal/*
@/mocks/*
scripts/echo-ws.mjs
```

Continue rejecting Electron, `node-pty`, Node built-ins and machine-specific absolute paths. Test one forbidden Stage 0 import and one allowed `monaco-editor` browser import. Do not classify the existing environment-guarded `main.tsx -> mocks/browser` dynamic import as a Stage 2 violation; production artifact scanning remains the proof that Vite eliminates mock code.

- [ ] **Step 3: Add contract-name protection**

Scan production contracts and file feature code for forbidden resource words used as identifiers: `pvcName`, `podName`, `jobName`, `namespace`, `serviceAccount`. Do not reject explanatory comments or evidence documents; the check targets source identifiers and serialized property names.

- [ ] **Step 4: Verify and commit**

```powershell
pnpm test:boundary
pnpm typecheck
git -C ../.. add poc4/frontend/package.json poc4/frontend/pnpm-lock.yaml poc4/frontend/scripts
git -C ../.. commit -m "chore(poc4): establish stage 2 browser boundaries"
```

## Task 2: Implement Relative Path, Runtime Contracts And File API

**Files:**

- Modify: `poc4/frontend/src/contracts/api.ts`
- Create: `poc4/frontend/src/contracts/file.ts`
- Create: `poc4/frontend/src/features/files/pathPolicy.ts`
- Create: `poc4/frontend/src/features/files/pathPolicy.test.ts`
- Create: `poc4/frontend/src/api/fileApi.ts`
- Create: `poc4/frontend/src/api/fileApi.test.ts`
- Modify: `poc4/frontend/src/api/httpClient.ts`
- Modify: `poc4/frontend/src/api/httpClient.test.ts`

- [ ] **Step 1: Write path-policy boundary tests**

Required table:

```ts
it.each([
  '/etc/passwd',
  '\\server\\share',
  'C:\\repo\\file',
  '../secret',
  'src/../../secret',
  './pom.xml',
  'src//App.java',
  'src\\App.java',
  'src/\0App.java',
])('rejects %s', (value) => {
  expect(() => parseProjectRelativePath(value)).toThrow('Project-relative path required');
});
```

Also prove `''` is accepted only by `parseProjectDirectoryPath`, `.gitignore` is accepted, Unicode names are preserved, and literal `%2e%2e` remains literal through `URLSearchParams`.

- [ ] **Step 2: Define runtime-checked response contracts**

Implement the contract shapes above plus narrow parsing functions. Reject negative/non-finite sizes, duplicate sibling paths, mismatched parent directory, file entries with `hasChildren !== null`, directory entries with non-null `sizeBytes`, or inconsistent metadata modes.

Do not silently drop an invalid node and show a partial tree. Throw one `Invalid file response` error so the UI can stop and offer retry.

- [ ] **Step 3: Test metadata-first API URL construction**

Assert exact methods and URL semantics:

```ts
expect(requestUrl.pathname).toBe('/api/v1/projects/prj%2Fopaque/files/meta');
expect(requestUrl.searchParams.get('path')).toBe('src/main/java/demo/App.java');
```

No API accepts raw string after parsing; exported functions require branded `ProjectRelativePath` or `ProjectDirectoryPath`.

- [ ] **Step 4: Add authenticated Blob support**

Extend `HttpClient` with a separate `requestBlob()` path that retains existing Bearer and current-token 401 semantics. It returns:

```ts
type BlobResponse = {
  blob: Blob;
  filename: string;
};
```

Accept filename only from a validated `Content-Disposition` filename or metadata fallback. Strip path separators, control characters and blank names. Never put JWT in the URL or DOM.

- [ ] **Step 5: Implement file API functions**

```ts
listDirectory(projectId, directory): Promise<FileTreeResponse>;
getFileMetadata(projectId, path): Promise<FileMetadata>;
getFileContent(projectId, path): Promise<FileContentResponse>;
downloadFileBlob(projectId, path, fallbackName): Promise<BlobResponse>;
```

Update `ApiErrorCode` with `INVALID_PATH`, `FILE_TOO_LARGE` and `BINARY_FILE`. Keep `UNSUPPORTED_ENCODING` as a metadata block reason, not a new server error unless the backend contract later adopts it.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/files/pathPolicy.test.ts src/api/fileApi.test.ts src/api/httpClient.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src/contracts poc4/frontend/src/features/files poc4/frontend/src/api
git -C ../.. commit -m "feat(poc4): define read-only file contracts"
```

## Task 3: Build Deterministic Read-Only File MSW Fixtures

**Files:**

- Create: `poc4/frontend/src/mocks/fileFixtures.ts`
- Modify: `poc4/frontend/src/mocks/state.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/handlers.test.ts`

- [ ] **Step 1: Define a Maven workspace fixture**

Alice's ready project contains at least:

```text
/
├─ .gitignore
├─ README.md
├─ pom.xml
├─ assets/
│  └─ logo.png
├─ docs/
│  ├─ large-notes.md
│  └─ too-large.md
└─ src/
   ├─ main/java/demo/App.java
   ├─ main/java/demo/NearLimit.java
   └─ test/java/demo/AppTest.java
```

Use exact metadata boundaries:

- `pom.xml`, Java and normal Markdown: `MONACO_TEXT`, UTF-8, at most `20 * 1024 * 1024` bytes.
- `large-notes.md`: `20 * 1024 * 1024 + 1`, `PLAIN_TEXT`.
- `too-large.md`: `50 * 1024 * 1024 + 1`, `BLOCKED / FILE_TOO_LARGE`.
- `logo.png`: `BLOCKED / BINARY_FILE`, encoding null.
- Add one non-UTF-8 text fixture: `BLOCKED / UNSUPPORTED_ENCODING`.
- Add `src/main/java/demo/NearLimit.java` at `20 * 1024 * 1024 - 1` bytes for the opt-in real-size Monaco test.

Store normal files as small strings. Generate the exact large-file strings only when the dedicated large-file handler is enabled so ordinary tests do not allocate 40 MiB repeatedly.

- [ ] **Step 2: Implement owner-checked handlers**

Every file handler first authenticates and checks project ownership and `READY` state. Inaccessible and unknown projects use the same generic `403`. Invalid paths return `400 INVALID_PATH` without echoing physical paths.

Directory listing returns direct children only. Record request counters keyed by `{method, projectId, path}` for lazy-loading and no-content-fetch assertions.

- [ ] **Step 3: Enforce content policy server-side in mocks**

- `MONACO_TEXT` and `PLAIN_TEXT` return content and `workspaceRevision`.
- `BLOCKED / BINARY_FILE` returns `415 BINARY_FILE` if content is requested directly.
- `BLOCKED / FILE_TOO_LARGE` returns `413 FILE_TOO_LARGE`.
- Unsupported encoding returns a generic validation error without content.
- Download returns bytes for all file fixtures and a sanitized filename.

This proves UI bypass does not change the mock server policy; it still does not prove a real backend.

- [ ] **Step 4: Test exact boundary values and ownership**

Handler tests cover byte sizes `20 MiB`, `20 MiB + 1`, `50 MiB`, `50 MiB + 1`, binary, non-UTF-8, root/child listing, hidden files, Alice/Bob isolation, malformed relative paths and non-ready projects.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test -- src/mocks/handlers.test.ts
pnpm typecheck
git -C ../.. add poc4/frontend/src/mocks
git -C ../.. commit -m "test(poc4): simulate read-only project files"
```

## Task 4: Add Workspace Session State And Cleanup Semantics

**Files:**

- Create: `poc4/frontend/src/features/editor/workspaceSession.ts`
- Create: `poc4/frontend/src/features/editor/workspaceSession.test.ts`
- Modify: `poc4/frontend/src/features/editor/editorTypes.ts`
- Modify: `poc4/frontend/src/app/appRuntime.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Create: `poc4/frontend/src/lib/projectMonacoModels.ts`
- Create: `poc4/frontend/src/lib/projectMonacoModels.test.ts`
- Create: `poc4/frontend/src/runtime/WorkspaceResourceRegistry.ts`
- Create: `poc4/frontend/src/runtime/WorkspaceResourceRegistry.test.ts`

- [ ] **Step 1: Write the Zustand state tests**

State shape:

```ts
type WorkspaceSessionState = {
  projectId: string | null;
  expandedPaths: Set<ProjectRelativePath>;
  selectedPath: ProjectRelativePath | null;
  openPaths: ProjectRelativePath[];
  activePath: ProjectRelativePath | null;
  activateProject(projectId: string): void;
  toggleDirectory(path: ProjectRelativePath): void;
  selectPath(path: ProjectRelativePath | null): void;
  openFile(path: ProjectRelativePath): void;
  closeFile(path: ProjectRelativePath): void;
  reorderTabs(fromIndex: number, toIndex: number): void;
  reset(): void;
};
```

Tests require deduplicated tabs, deterministic active-tab selection after close, descendant expanded paths removed when a parent collapses, immutable Set/array updates, same-project activation preserving state and different-project activation resetting state.

- [ ] **Step 2: Implement a non-persistent typed store**

Use Zustand v5 `create<WorkspaceSessionState>()(...)` with selectors. Do not use `persist`, `localStorage` or `sessionStorage`. Export `workspaceSessionStore` access through the hook's `getState()` only where runtime cleanup needs it.

- [ ] **Step 3: Make Monaco URIs project-scoped**

Create:

```ts
toProjectModelUri(projectId, path): monaco.Uri;
disposeProjectModel(projectId, path): void;
disposeProjectModels(projectId): void;
disposeAllProjectModels(): void;
```

URI scheme remains `poc4`, authority remains a constant such as `workspace`, and path contains separately encoded opaque project ID plus validated relative path segments. Tests prove two projects with the same file path never share a model and opaque IDs containing `/`, `?` or `#` cannot alter URI structure.

- [ ] **Step 4: Keep Monaco out of the eager runtime**

`appRuntime.ts` must not import `monaco-editor` or `projectMonacoModels.ts`, because that would pull Monaco into the login/project-list entry chunk. Add a small `WorkspaceResourceRegistry` that stores synchronous disposer callbacks. The lazy workbench registers `disposeAllProjectModels()` when it loads and unregisters that callback when it permanently unmounts.

The registry calls each disposer once, continues after one throws and clears its set. Add isolated registry tests.

- [ ] **Step 5: Integrate cleanup into the runtime**

Both explicit logout and current-session 401 execute:

1. Close registered connections.
2. Dispose all registered workspace resources, including project Monaco models when the lazy workbench has loaded.
3. Reset workspace session.
4. Clear Query Cache.
5. Clear auth session.

The existing stale-old-token 401 protection remains unchanged. Add a regression proving Alice's late 401 still cannot clear Bob's workspace state or registered resources.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/editor/workspaceSession.test.ts src/lib/projectMonacoModels.test.ts src/runtime/WorkspaceResourceRegistry.test.ts src/app/appRuntime.test.ts
pnpm typecheck
git -C ../.. add poc4/frontend/src/features/editor poc4/frontend/src/lib/projectMonacoModels* poc4/frontend/src/runtime/WorkspaceResourceRegistry* poc4/frontend/src/app
git -C ../.. commit -m "feat(poc4): manage project-scoped workspace sessions"
```

## Task 5: Implement Lazy Read-Only File Tree

**Files:**

- Create: `poc4/frontend/src/features/files/fileQueries.ts`
- Create: `poc4/frontend/src/features/files/fileQueries.test.ts`
- Create: `poc4/frontend/src/components/files/FileTreeNode.tsx`
- Create: `poc4/frontend/src/components/files/ReadonlyFileTree.tsx`
- Create: `poc4/frontend/src/components/files/ReadonlyFileTree.test.tsx`

- [ ] **Step 1: Define hierarchical file query keys**

```ts
export const fileKeys = {
  all: (projectId: string) => ['project-files', projectId] as const,
  tree: (projectId: string, path: ProjectDirectoryPath) =>
    ['project-files', projectId, 'tree', path] as const,
  meta: (projectId: string, path: ProjectRelativePath) =>
    ['project-files', projectId, 'meta', path] as const,
  content: (projectId: string, path: ProjectRelativePath) =>
    ['project-files', projectId, 'content', path] as const,
};
```

Tree, metadata and content queries use `retry: false`, `staleTime: 30_000` and the existing default five-minute garbage collection. Tree queries are enabled only for root or an expanded directory. Content remains disabled until successful metadata authorizes `MONACO_TEXT` or `PLAIN_TEXT`.

The sidebar refresh command cancels current-project file requests, then invalidates `fileKeys.all(projectId)`. It does not clear open tabs or models; successful refetch updates read-only content. Collapse-all changes only Zustand expanded state and must not delete Query Cache.

- [ ] **Step 2: Test lazy request behavior**

Component tests assert:

- Mount requests only `path=''`.
- Collapsed `src` makes no child request.
- Expanding `src` makes exactly one child request.
- Collapse/re-expand uses cached data without a second request while fresh.
- Loading, empty-directory, local directory error and retry are scoped to that node.
- Root error does not render a misleading empty workspace.
- Hidden `.gitignore` is visible.

- [ ] **Step 3: Build the read-only tree from selected EnsoAI behavior**

Reuse visual density, chevrons, folder/file icons, selection and scroll-into-view. Deliberately omit EnsoAI's Electron calls, Git decoration, persistence, drag timers, clipboard, CRUD, context menu, search and operation history.

Required accessibility:

- `role="tree"` and `role="treeitem"`.
- `aria-expanded` on directories.
- `aria-selected` on the selected file.
- Enter opens/toggles; ArrowRight expands; ArrowLeft collapses or focuses parent; ArrowUp/ArrowDown traverse currently visible nodes.
- Icon-only refresh and collapse-all buttons have tooltips and stable 32 px hit boxes.

- [ ] **Step 4: Sort without mutating Query Cache**

Return a copied array sorted directories first, then files, then case-insensitive name with original name as deterministic tie-breaker. Never mutate MSW/TanStack cached arrays in render.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test -- src/features/files/fileQueries.test.ts src/components/files/ReadonlyFileTree.test.tsx
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src/features/files poc4/frontend/src/components/files/FileTreeNode.tsx poc4/frontend/src/components/files/ReadonlyFileTree*
git -C ../.. commit -m "feat(poc4): add lazy read-only file tree"
```

## Task 6: Implement Metadata-Gated Multi-Tab File Viewing

**Files:**

- Create: `poc4/frontend/src/components/files/ReadonlyEditorWorkspace.tsx`
- Create: `poc4/frontend/src/components/files/ReadonlyEditorWorkspace.test.tsx`
- Create: `poc4/frontend/src/components/files/ReadonlyMonacoEditor.tsx`
- Create: `poc4/frontend/src/components/files/PlainTextViewer.tsx`
- Create: `poc4/frontend/src/components/files/BlockedFileView.tsx`
- Create: `poc4/frontend/src/components/files/downloadFile.ts`
- Create: `poc4/frontend/src/components/files/downloadFile.test.ts`
- Create: `poc4/frontend/src/lib/languageForFile.ts`
- Modify: `poc4/frontend/src/components/files/EditorTabs.tsx`
- Modify: `poc4/frontend/src/features/files/fileQueries.ts`

- [ ] **Step 1: Write metadata-first component tests**

For each opened path, assert request order and render mode:

| Metadata | Content request | View |
|---|---:|---|
| `MONACO_TEXT` | exactly 1 | read-only Monaco |
| `PLAIN_TEXT` | exactly 1 | read-only plain textarea |
| `BLOCKED/BINARY_FILE` | 0 | metadata + Download |
| `BLOCKED/FILE_TOO_LARGE` | 0 | metadata + Download |
| `BLOCKED/UNSUPPORTED_ENCODING` | 0 | metadata + Download |

Metadata loading, metadata error, content loading and content error must be distinct states with retry scoped to the failed request.

- [ ] **Step 2: Adapt tabs without changing the Stage 0 contract**

Keep `EditorTabs` reusable. Stage 2 tabs always pass `isDirty: false`; no save dot, close confirmation or auto-save. Tab label comes from the final validated path segment, with full relative path in tooltip. Reorder updates only Zustand state.

- [ ] **Step 3: Implement read-only Monaco**

Use existing Vite workers and:

```tsx
<Editor
  path={toProjectModelUri(projectId, path).toString()}
  value={content}
  language={metadata.language || languageForFile(path)}
  theme="vs-dark"
  options={{
    readOnly: true,
    domReadOnly: true,
    automaticLayout: true,
    scrollBeyondLastLine: false,
  }}
/>
```

Do not add `onChange`. Tab switching retains models and view state. Closing a tab disposes only its model after the editor has switched away. Project cleanup uses Task 4 functions.

- [ ] **Step 4: Implement the plain-text downgrade**

Use a full-size read-only `<textarea wrap="off" spellCheck={false}>`, not Monaco, Markdown preview or `contentEditable`. Display name, formatted byte size and `Plain text` mode in the toolbar. The DOM must contain zero `.monaco-editor` elements for this active file.

- [ ] **Step 5: Implement blocked metadata and download**

Show file name, media type, formatted bytes and one clear reason. Download calls the authenticated Blob API, creates an object URL, clicks a temporary anchor and revokes the URL in `finally`. Disable only while its request is active. Failure shows an inline retryable error without navigating away.

- [ ] **Step 6: Verify model and request cleanup**

Tests prove close-after-switch ordering, content never loads for blocked metadata, changing projects disposes old models, duplicate file clicks do not duplicate tabs/requests and stale old-project responses cannot activate a tab in the new project.

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test -- src/components/files/ReadonlyEditorWorkspace.test.tsx src/components/files/downloadFile.test.ts src/lib/projectMonacoModels.test.ts
pnpm typecheck
pnpm build
git -C ../.. add poc4/frontend/src/components/files poc4/frontend/src/features/files/fileQueries.ts poc4/frontend/src/lib
git -C ../.. commit -m "feat(poc4): add metadata-gated file viewers"
```

## Task 7: Assemble The Production Read-Only Workbench

**Files:**

- Create: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Create: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Create: `poc4/frontend/src/features/projects/ReadonlyWorkbenchPage.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`
- Modify: `poc4/frontend/src/test/renderApp.tsx`
- Modify: `poc4/frontend/src/styles/globals.css`

- [ ] **Step 1: Test project-state routing before loading Monaco**

`CREATING`, `FAILED`, forbidden and network-error project routes must not download the workbench chunk or render a file API request. Only `READY` renders a `Suspense` boundary around lazy `ReadonlyWorkbenchPage`.

Keep the existing Stage 1 state gates and generic 403 language unchanged.

- [ ] **Step 2: Build the workbench shell**

Layout:

- 48 px top bar with back-to-projects icon, project name, `READY` status and logout.
- 256 px file sidebar with project-relative root label, refresh and collapse-all.
- Main area with compact `File / Run / Terminal` segmented navigation.
- File is active. Run and Terminal are visible but disabled with accessible labels; do not render fake logs, echo terminal or explanatory placeholder panels.
- Editor area fills the remaining viewport with stable min/max constraints.
- A focus-visible `Skip to editor` link moves focus to the active viewer without changing the selected file.
- Active tab, selected tree node and blocked reason use icon/shape/text in addition to color.

At 1280 px, sidebar, tabs, viewer toolbar and content must remain reachable without document-level horizontal scrolling.

- [ ] **Step 3: Connect tree and editor state**

Clicking a directory only toggles expansion. Clicking a file selects and opens it. Selecting an existing tab updates the tree selection and scrolls it into view if its ancestors are expanded. Closing the last tab renders a quiet empty editor surface, not a marketing card.

- [ ] **Step 4: Handle project transitions**

On mount call `activateProject(project.id)`. Before activating a different project:

1. Cancel old project file queries.
2. Dispose old project models.
3. Remove old project file queries with `removeQueries({ queryKey: fileKeys.all(oldId) })`.
4. Reset and activate the new project session.

Cleanup caused by React StrictMode must be idempotent and must not erase the newly activated same-project session.

- [ ] **Step 5: Verify production chunking**

```powershell
pnpm build
```

Expected: login/project list remain in a non-Monaco entry chunk; a separate workbench chunk and five Monaco workers are produced. Record sizes but do not hide the >500 kB warning by raising `chunkSizeWarningLimit`.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/shell/WorkbenchShell.test.tsx src/features/projects
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src/components/shell poc4/frontend/src/features/projects poc4/frontend/src/test/renderApp.tsx poc4/frontend/src/styles/globals.css
git -C ../.. commit -m "feat(poc4): assemble the read-only project workbench"
```

## Task 8: Lock Error, Authorization And Stale-Response Behavior

**Files:**

- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/api/httpClient.test.ts`
- Modify: `poc4/frontend/src/mocks/handlers.test.ts`
- Modify: `poc4/frontend/src/components/files/ReadonlyEditorWorkspace.test.tsx`
- Modify: `poc4/frontend/src/components/files/ReadonlyFileTree.test.tsx`

- [ ] **Step 1: Test current-session 401 cleanup with open files**

Arrange open tabs, expanded paths, cached file data, two Monaco models and a registered connection. A current-token 401 must clear all of them once and redirect to login through existing auth behavior.

- [ ] **Step 2: Preserve the stale-old-session 401 guarantee**

Arrange Alice's delayed file-content 401, then log in as Bob and open Bob's project/file before Alice resolves. Assert Alice's late response cannot clear Bob's auth, workspace state, file cache or model.

- [ ] **Step 3: Test forbidden and malformed file responses**

- Alice requesting Bob's file receives generic access denied without Bob/project/path leakage.
- Invalid tree response stops the affected tree and offers retry.
- Path error messages never print physical server paths.
- A blocked content bypass remains rejected.
- Download 401 uses the same current-token cleanup rules.

- [ ] **Step 4: Test retry isolation**

Retrying one failed directory must not refetch successful siblings. Retrying metadata must not fetch content before metadata succeeds. Retrying content must not duplicate the tab or model.

- [ ] **Step 5: Verify and commit**

```powershell
pnpm test
pnpm typecheck
pnpm test:boundary
git -C ../.. add poc4/frontend/src
git -C ../.. commit -m "test(poc4): harden read-only workspace failure boundaries"
```

## Task 9: Add Browser, Visual And Real-Size File Evidence

**Files:**

- Create: `poc4/frontend/tests/e2e/stage2.spec.ts`
- Create: `poc4/frontend/tests/e2e/stage2-large-files.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Create: twelve PNG files under `poc4/docs/evidence/stage-2/`

- [ ] **Step 1: Add the core Stage 2 browser workflow**

Required cases:

1. Login and open Alice's ready project.
2. Initial page requests root tree only and displays `.gitignore`.
3. Expand `src -> main -> java -> demo` lazily; each directory request count is one.
4. Open `pom.xml` and `App.java`; switch tabs and preserve view state.
5. Attempt typing in Monaco and prove content plus dirty indicators remain unchanged.
6. Close a tab and prove its model is disposed while the other remains.
7. Open binary, non-UTF-8 and >50 MiB files; no content request occurs and Download remains available.
8. Open 20–50 MiB Markdown; plain viewer appears and `.monaco-editor` count for the active viewer is zero.
9. Switch to another project or logout; tabs, expanded paths and file cache do not leak into the next session.
10. Force current-token 401 with an open file; return to login with workspace cleared.
11. Complete root-tree expansion, file opening, tab switching, closing and Download using the keyboard; verify the skip link and visible focus order.

Use network request observation and accessible state, not fixed sleeps.

- [ ] **Step 2: Add actual-byte large-file tests**

Add:

```json
"test:e2e:large-files": "playwright test tests/e2e/stage2-large-files.spec.ts --project=chromium"
```

The handler lazily creates an actual `20 MiB - 1` Java string and an actual `20 MiB + 1` Markdown string. The Chromium test has an explicit 120-second ceiling and records:

- Response byte count.
- Time from click to viewer-ready status.
- Monaco vs plain-text renderer choice.
- Read-only behavior after a keyboard input attempt.
- Browser page and console errors.

This is a POC measurement, not a production performance SLA. If either real-size case crashes, times out or becomes unresponsive, Stage 2 decision is remediation required; do not replace the payload with a small string while keeping a large metadata number.

- [ ] **Step 3: Capture visual evidence**

Capture the populated workbench and blocked-binary state in Chrome and Edge at 1280x720, 1440x900 and 1920x1080. Before capture wait for fonts and Monaco content, disable animations and hide carets.

Assert:

- Sidebar/main boundary does not overlap.
- Tree controls, active tab, close button and Download are reachable.
- No document horizontal overflow.
- Monaco canvas contains non-background pixels and source text.
- Long relative paths truncate visually but remain available in tooltip.
- PNG dimensions match CSS viewport; hashes are not acceptance criteria.

- [ ] **Step 4: Run all browser suites**

```powershell
pnpm test:e2e
pnpm test:e2e:channels
pnpm test:e2e:large-files
```

Expected: Stage 0, Stage 1 and Stage 2 core tests pass in Chromium; core workflows and twelve Stage 2 captures pass in installed Chrome and Edge; actual-byte tests pass in Chromium.

- [ ] **Step 5: Commit**

```powershell
git -C ../.. add poc4/frontend/tests/e2e poc4/frontend/playwright.config.ts poc4/frontend/package.json poc4/frontend/pnpm-lock.yaml poc4/docs/evidence/stage-2
git -C ../.. commit -m "test(poc4): verify stage 2 read-only workbench"
```

## Task 10: Final Verification And Stage 2 Evidence Report

**Files:**

- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-2/result.md`

- [ ] **Step 1: Update only working documentation**

README documents the read-only workbench, mock credentials, file modes, `pnpm test:e2e:large-files`, production/mock build distinction and the fact that all file authorization/path safety remains mock contract until a real backend exists.

- [ ] **Step 2: Run the final matrix on one exact code SHA**

```powershell
pnpm test:boundary
pnpm typecheck
pnpm test
pnpm build
pnpm build:mock
pnpm test:e2e
pnpm test:e2e:channels
pnpm test:e2e:large-files
```

After E2E, rebuild production before scanning because mock builds overwrite `dist`:

```powershell
pnpm build
git -C ../.. diff --check
git -C ../.. status --short
```

- [ ] **Step 3: Verify production exclusions and artifacts**

Scan production `dist` for:

```text
demo-pass
mockServiceWorker
/api/v1/session/expire
127.0.0.1:4174
stage0.html
window.electronAPI
node-pty
```

Expected: zero matches. Separately prove `dist` contains the workbench chunk and five Monaco Worker assets. Record entry/workbench/worker raw and gzip sizes.

- [ ] **Step 4: Verify encoding and tracked scope**

Strict-decode tracked frontend/docs text as UTF-8, require BOM count zero, run `git diff --check`, and confirm only Stage 2 expected files plus pre-existing user paths appear. Do not add `.grok/` or any unrelated worktree/cache directory.

- [ ] **Step 5: Write the evidence report**

Required sections:

```markdown
# EnsoAI Stage 2 Read-Only Workbench Result

## Source Commit
## Scope Boundary
## Automated Verification
## Relative Path And Contract Evidence
## Lazy File Tree Evidence
## Metadata And Size-Gate Evidence
## Monaco And Model Lifecycle Evidence
## Download Evidence
## Browser And Visual Evidence
## Real-Size File Measurements
## Production Exclusion Evidence
## Known Gaps
## Decision
## Confidence
```

Decision is `READY_FOR_STAGE_3_PLAN` only when all eleven exit-gate items pass. Otherwise use `STAGE_2_REMEDIATION_REQUIRED`. The report must say **mock contract verified** and list real backend/PVC/symlink/ownership verification as unresolved.

- [ ] **Step 6: Commit the result**

```powershell
git -C ../.. add poc4/frontend/README.md poc4/docs/evidence/stage-2/result.md
git -C ../.. commit -m "docs(poc4): record stage 2 read-only workbench result"
git -C ../.. status --short
```

## Acceptance Traceability

| Required behavior | Primary implementation | Primary proof |
|---|---|---|
| Only relative file paths leave browser | `pathPolicy.ts`, `fileApi.ts` | table tests + observed request URLs |
| Root then lazy directory reads | `fileQueries.ts`, `ReadonlyFileTree.tsx` | request-counter component/E2E tests |
| Hidden files visible | `ReadonlyFileTree.tsx` | `.gitignore` component/E2E assertion |
| Multi-tab read-only editing surface | `ReadonlyEditorWorkspace.tsx` | component + browser tab workflow |
| Project-isolated Monaco models | `projectMonacoModels.ts` | URI/dispose unit tests |
| Binary and over-limit never enter Monaco | metadata gate | zero-content-request tests |
| 20–50 MiB Markdown avoids Monaco | `PlainTextViewer.tsx` | actual-byte Chromium test |
| Blocked files remain downloadable | Blob API + `downloadFile.ts` | auth/header/object URL tests |
| Logout/401 removes workspace data | `appRuntime.ts`, Zustand reset | current/stale-session integration tests |
| No Electron or mock in production | boundary script + artifact scan | final build evidence |
| Layout usable at supported widths | `WorkbenchShell.tsx` | Chrome/Edge geometry and PNG checks |
| Keyboard and focus behavior remains usable | tree/tabs/shell semantics | keyboard-only E2E + accessibility assertions |

## Known Risks Carried Forward

- 真实后端文件 API、JWT 校验、项目所有权、PVC 路径规范化和 symlink escape 尚未实现或验证。
- MSW 目录结构和错误码只能稳定前端契约，不能模拟 NFS 延迟、Pod 重启或大目录规模。
- 19–20 MiB Monaco 和 20–50 MiB plain-text 测试只能证明当前测试机器可运行，不构成生产 SLA。
- 下载在浏览器内通过 Blob 暂存，接近存储上限时会产生额外内存占用；真实后端可在后续评审 range/streaming 或短期下载 ticket。
- 工作台状态故意不持久化；刷新页面会因阶段 1 的内存 JWT 回到登录页。
- Stage 2 不实现写入，所以 workspaceRevision 只读取和保留，不参与冲突控制；阶段 3 才验证保存与 revision。
- Run 和 Terminal 在生产 Shell 中保持禁用，阶段 0 echo terminal 仍仅用于独立回归。

## Execution Start Condition

实施前从包含阶段 1 合并提交 `0b720a5` 和本计划提交的 `master` 创建新隔离 worktree，分支名使用 `codex/poc4-stage-2-readonly-workbench`。若计划提交后 `master` 出现应用代码变化，执行者必须重新读取相关文件并调整精确路径，不覆盖用户改动。
