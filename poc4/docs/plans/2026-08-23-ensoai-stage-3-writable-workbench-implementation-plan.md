# EnsoAI Stage 3 Writable Workbench Implementation Plan

> **Execution rule:** Implement task by task in a new isolated worktree created from the accepted Stage 3 plan commit. Use TDD for every behavior change, pnpm for every package operation, small focused patches, and one focused commit per task. Do not start Stage 4 Run/log work from this plan.

**Goal:** 在阶段 2 只读工作台基础上交付受控文件写入：可编辑 Monaco 与大 Markdown 纯文本缓冲区、显式保存和 `Ctrl+S`、准确 dirty 状态、workspace revision、文件/目录创建、同目录重命名和确认删除；所有写操作继续只使用项目内相对路径，并在服务端拒绝锁定、冲突或失败时保留未保存缓冲区。

**Architecture:** TanStack Query 继续管理目录、metadata、正文和最新已确认 `workspaceRevision` 等服务端状态。Zustand 只管理非持久化工作台会话和轻量 dirty/path 映射。新的 `WorkspaceBufferRegistry` 管理 Monaco model 与纯文本编辑缓冲区的内容、保存基线和销毁，不把几十 MiB 正文复制进 Zustand。所有文件 mutation 以项目 ID 为 scope 串行执行；成功后先接纳服务端响应，再原子更新 revision、Query Cache、标签路径和 models，不做乐观的破坏性写入。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、React Router 8.3.0、TanStack Query 5.101.4、Zustand 5.0.15、Monaco Editor 0.55.1、`@monaco-editor/react` 4.7.0、MSW 2.15.0、Vitest、Testing Library、Playwright、Tailwind CSS 4、Lucide React。

**Current documentation checked on 2026-08-23:** Monaco 官方资料确认 dirty 需要应用自行基于 `onDidChangeContent` 管理，编辑器通过 `readOnly: false` 可写，模型切换可保存/恢复 view state，editor/model 均需显式 dispose。TanStack Query v5 官方资料确认 mutation response 可用 `setQueryData` 写回、cache 更新必须 immutable、`cancelQueries` 可防止旧 refetch 覆盖、相同 `scope.id` 的 mutation 串行执行。Zustand v5 官方资料确认 TypeScript 使用 `create<T>()(...)`、store 可用 `getInitialState()` reset。本计划不升级任何这些依赖。

---

## Scope And Non-Negotiable Boundaries

### Included

- `READY` 项目的生产可写工作台；阶段 2 的 metadata-first、大小分级和下载行为继续成立。
- `MONACO_TEXT` 使用可编辑 Monaco；`PLAIN_TEXT` 使用可编辑、无 Markdown 增强的纯文本缓冲区；`BLOCKED` 仍不可编辑且正文请求数为零。
- 显式 Save 图标按钮和当前活动文件的 `Ctrl+S` / `Cmd+S`。
- 多标签 dirty 标记、切换保留缓冲区、保存中继续编辑不错误清除 dirty。
- dirty 标签关闭确认、离开项目确认、logout 确认和浏览器 `beforeunload` 防丢失。
- 文件与目录创建、同目录重命名、确认删除；隐藏名称和 Unicode 名称继续支持。
- workspace revision 的初始化、每次写请求携带、成功推进和 `409` 冲突处理。
- 服务端 `409 PROJECT_LOCKED`、`409 WORKSPACE_REVISION_CONFLICT`、`409 ENTRY_ALREADY_EXISTS`、`409 DIRECTORY_NOT_EMPTY` 等前端行为。
- 写成功后的目录、metadata、正文、标签、选中项和 Monaco model 一致性。
- mock API、单元/组件测试、Chromium/Chrome/Edge E2E、视觉证据和真实约 20 MiB 写入验证。

### Explicitly excluded

- 真实 Spring Boot、MySQL、PVC、工作区 Pod、symlink escape 或 Kubernetes 文件代理。
- Run 创建/停止、active Run 查询、运行状态机、日志、WebSocket ticket、生产终端和命令审计。
- 运行结束后的强制工作区重载；它属于 Stage 4/6，不可用 Stage 3 mock 写入替代。
- 上传、拖拽文件树、跨目录移动、复制粘贴、批量操作、搜索、Git decoration、自动保存和保存全部快捷键。
- 同项目多个浏览器标签页的并发编辑合并、diff/merge UI、版本历史、撤销已提交的文件 CRUD。
- Markdown 预览、格式化、自动 AI 上下文或 AI 写入。
- 非空目录的无提示删除、项目删除和回收站。

### Security interpretation

- 本阶段结论仍只能写为 **mock contract verified**。MSW 不能证明真实 JWT 签名、项目所有权、PVC 根目录约束、符号链接逃逸防护、原子写入或后端运行锁。
- 浏览器路径校验是输入卫生，不是安全边界。服务端必须重新校验 owner、project、路径、文件类型、大小、revision 和锁状态。
- 浏览器只发送不透明 `projectId`、项目内正斜杠相对路径、业务写入参数和 opaque revision；合同不得出现 PVC、Pod、Job、Namespace、ServiceAccount 或物理绝对路径。
- UI disabled、dirty 标记和 mutation scope 都不是安全边界。真实后端必须拒绝运行期写入和过期 revision。
- `workspaceRevision` 是 opaque token，只比较完全相等；前端不得解析、排序、加一或从时间推断新旧。
- JWT 只在 Bearer header；不得放入 URL、下载名、编辑缓冲区、日志或截图。

### Stage boundary for `PROJECT_LOCKED`

Stage 3 只验证文件写接口返回 `409 PROJECT_LOCKED` 时：不更新 cache/revision、不清除 dirty、不自动重试，并给出明确错误。本阶段没有权威 active Run endpoint，因此不宣称已经实现“运行开始即主动锁定全部编辑器”或“Run 结束后正确解锁”。这两项必须在 Stage 4 的 Run authority 状态机中完成。

### UI and accessibility guardrails

- 保持阶段 2 已验收的 EnsoAI 密度、主题 token、系统字体、256 px 文件树、36 px 标签和 1280 px 最低宽度。
- 不采用 `ui-ux-pro-max` 搜索返回的横向营销旅程、鲜艳 block layout、32 px 大标题、浮动 CTA、卡片堆叠或 hover scale；这些不适合重复操作的 IDE。
- 保存、新建文件、新建目录、重命名和删除使用 Lucide 图标；icon-only 按钮必须有 `title`、`aria-label`、固定命中尺寸和可见 focus ring。
- 删除必须经过模态确认；dirty 关闭/离开必须有 Save/Discard/Cancel 或 Discard/Cancel 的明确选择。模态打开后聚焦安全动作，Tab 不逃逸，Escape 等价 Cancel，关闭后恢复触发元素焦点。
- 错误使用 `role="alert"`，保存成功等被动反馈使用 `role="status"`。不得只用颜色表示 dirty、保存中、失败或锁定。
- 键盘顺序与视觉顺序一致；树、标签、编辑器、Save、CRUD 和确认按钮均可达。Monaco 不得吞掉 `Ctrl+S` 后触发浏览器保存页面。
- hover 只改变颜色/透明度，不用缩放造成布局位移；动画遵守 `prefers-reduced-motion`。
- 不把操作说明、快捷键教程或功能介绍常驻在工作台中；仅在 tooltip、错误、确认和即时状态中给必要反馈。

### Stage 3 exit gate

只有以下条件全部满足，阶段 3 才结束：

1. 所有写 API 只接受 branded 项目内相对路径；创建/重命名的 basename 经过前端构造检查，MSW 再独立拒绝绝对路径、反斜杠、`.`、`..`、NUL、逃逸和非法 parent。
2. 初次根目录响应建立非空 opaque `workspaceRevision`；每次保存/创建/重命名/删除携带当前 revision，每次成功响应推进 revision，客户端从不自行生成 revision。
3. 同项目文件写操作严格串行；写入期间不会被 tree/content refetch 覆盖，跨项目操作不共享 mutation scope 或 revision。
4. Monaco 和纯文本均可编辑；切换标签保留缓冲区。Monaco undo 回保存基线可恢复 clean；大文本采用保守 dirty epoch，不对每次按键扫描 20 MiB 字符串。
5. Save 按钮和 `Ctrl+S` 只保存活动文件。保存成功仅在当前缓冲区仍等于请求快照时清 dirty；保存中继续编辑必须在响应后保持 dirty。
6. 网络、`401`、`403`、`409`、`413`、`415` 和 `5xx` 不会被显示为保存成功。除当前 token `401` 按既有安全规则清会话外，失败均保留缓冲区和 dirty。
7. dirty 标签关闭、返回项目列表、logout、SPA 历史导航和页面 unload 均有防丢失行为；取消操作不改变标签、模型、认证或路由。
8. 创建文件/目录、同目录重命名和确认删除更新正确 parent tree；重命名映射展开项/选中项/标签，删除清理目标及后代的标签、缓存和 models。
9. dirty 文件或包含 dirty 后代的目录不得重命名/删除；用户必须先保存或明确丢弃对应缓冲区。非空目录删除必须二次确认，服务端仍可返回 `DIRECTORY_NOT_EMPTY`。
10. `BLOCKED` 永远不可写；越过 UI 的 PUT/CRUD 仍由 mock handler 做 owner、READY、path、revision、lock、类型和大小检查。
11. Run/Terminal 仍不发送任何生产请求。Run disabled reason 能区分“存在 dirty”与“Stage 4 未接入”，但 Stage 3 不声称真实运行锁闭环完成。
12. Chromium、真实 Chrome、真实 Edge 的核心工作流通过；1280 px 下工具栏、标签、dialogs 和树无重叠/裁切；真实 `20 MiB + 1` Markdown 写入在专用 180 秒上限内完成且记录实际请求字节和 viewer-ready/save-complete 时间。
13. 生产构建不包含 MSW worker、mock 凭据、Stage 3 scenario endpoint、echo URL 或 `stage0.html`；生产入口仍懒加载工作台/Monaco，边界扫描保持零 Electron/Node/物理资源标识。

## First-Principles State Ownership

| State | Owner | Reason |
|---|---|---|
| 文件树、metadata、已提交正文 | TanStack Query | 服务端状态，可失效和重取 |
| 最新已确认 `workspaceRevision` | TanStack Query `fileKeys.revision(projectId)` | 服务端令牌，不应进入 Zustand |
| 当前编辑缓冲区和保存基线 | `WorkspaceBufferRegistry` | 资源型、可订阅、需要显式 dispose，可能几十 MiB |
| dirty paths、打开/活动标签、展开/选中路径 | Zustand | 轻量、非持久化浏览器会话 |
| mutation pending/error | TanStack Mutation | 异步服务端操作状态 |
| Run/锁权威状态 | Stage 4 后端 query | 本阶段不伪造生产 authority |

禁止把完整文件内容放入 Zustand，也禁止用 React Query cache 直接承载未保存文本。Query cache 始终代表最后一次已确认服务端版本；buffer registry 代表用户当前工作副本。

## Contract Decisions

### Workspace revision

```ts
declare const workspaceRevisionBrand: unique symbol;

export type WorkspaceRevision = string & {
  readonly [workspaceRevisionBrand]: true;
};
```

`parseWorkspaceRevision` 只要求非空且长度不超过合理合同上限（建议 256 个 UTF-16 code units），不解释格式。Stage 3 扩展 `FileTreeResponse`：

```ts
export type FileTreeResponse = {
  directory: ProjectDirectoryPath;
  entries: FileTreeEntry[];
  workspaceRevision: WorkspaceRevision;
};
```

根目录是进入工作台后的首个文件请求，因此它为“尚未打开任何文件也能安全创建条目”提供初始 revision。任意后续 tree/content/mutation 响应可刷新同一 revision cache；queryFn 必须把 TanStack Query 提供的 `AbortSignal` 传到 `HttpClient`/`fetch`。Mutation 前先 cancel 当前项目相关文件 refetch，确认旧 GET 已被取消后再发送写请求，mutation success 的 revision 最后写入，防止旧 GET 在成功写后覆盖。

### Save contract

```ts
export type SaveFileRequest = {
  content: string;
  expectedWorkspaceRevision: WorkspaceRevision;
};

export type SaveFileResponse = {
  file: FileMetadata;
  workspaceRevision: WorkspaceRevision;
};
```

```text
PUT /api/v1/projects/{projectId}/files/content?path={relativeFile}
```

- 请求正文是用户按下 Save 时的不可变 snapshot，不是稍后再次读取 model 的值。
- 服务端成功前 Query cache 不变，dirty 不清除。
- 成功后把 snapshot 写入 content cache、把返回 `file` 写入 metadata cache、推进 revision。
- 如果返回 metadata 使 Markdown 跨越 `MONACO_TEXT` / `PLAIN_TEXT` 分界，dispose 旧 renderer 资源后按服务端模式重建；不得按扩展名或浏览器字节估算自行决定。
- 非 Markdown 超过 20 MiB、Markdown 超过 50 MiB 或编码不支持时由服务端拒绝；错误保留当前 buffer。

### Entry contracts

```ts
export type EntryKind = 'file' | 'directory';

export type CreateEntryRequest = {
  kind: EntryKind;
  path: ProjectRelativePath;
  expectedWorkspaceRevision: WorkspaceRevision;
};

export type CreateEntryResponse = {
  entry: FileTreeEntry;
  file: FileMetadata | null;
  workspaceRevision: WorkspaceRevision;
};

export type RenameEntryRequest = {
  path: ProjectRelativePath;
  nextPath: ProjectRelativePath;
  expectedWorkspaceRevision: WorkspaceRevision;
};

export type RenameEntryResponse = {
  path: ProjectRelativePath;
  nextPath: ProjectRelativePath;
  entry: FileTreeEntry;
  file: FileMetadata | null;
  workspaceRevision: WorkspaceRevision;
};

export type DeleteEntryRequest = {
  expectedWorkspaceRevision: WorkspaceRevision;
};

export type DeleteEntryResponse = {
  path: ProjectRelativePath;
  workspaceRevision: WorkspaceRevision;
};
```

```text
POST   /api/v1/projects/{projectId}/entries
POST   /api/v1/projects/{projectId}/entries/rename
DELETE /api/v1/projects/{projectId}/entries?path={relativePath}
```

- UI 只允许 rename basename，所以 `parent(path) === parent(nextPath)`；API 仍用完整 branded relative path，后端重复验证。
- 新文件内容固定为空 UTF-8 文本；不接受浏览器指定 media type、encoding 或 render mode。
- 创建目录返回 directory entry 和 `file: null`；创建文件返回 server metadata。
- 删除语义由服务端决定是否允许递归。本 mock 对非空目录默认返回 `409 DIRECTORY_NOT_EMPTY`；专门的确认用例可启用递归删除场景，但不能把它误写成真实后端已经安全实现。
- 所有 response 做运行时验证：路径必须与请求一致、entry basename/parent/kind 一致、file 与 entry 一致、revision 非空。

### New API errors

```ts
type Stage3ApiErrorCode =
  | 'PROJECT_LOCKED'
  | 'WORKSPACE_REVISION_CONFLICT'
  | 'ENTRY_ALREADY_EXISTS'
  | 'ENTRY_NOT_FOUND'
  | 'DIRECTORY_NOT_EMPTY';
```

- `PROJECT_LOCKED`：保留 dirty 和 buffer，显示锁定错误，不自动重试，不猜测 Run 状态。
- `WORKSPACE_REVISION_CONFLICT`：保留 dirty，停止后续 queued writes，提示重新加载；绝不带新 revision 自动覆盖。
- `ENTRY_ALREADY_EXISTS` / `ENTRY_NOT_FOUND` / `DIRECTORY_NOT_EMPTY`：保留 dialog 输入或选择状态，允许用户修正/取消。
- `401`：沿用阶段 1/2 当前 token 绑定清理规则；旧 token 的迟到 401 不得清除新会话。

### Dirty and save baseline

每个 buffer 暴露最小接口：

```ts
export type BufferSnapshot = {
  content: string;
  version: number;
};

export interface WorkspaceBuffer {
  readonly projectId: string;
  readonly path: ProjectRelativePath;
  readonly kind: 'monaco' | 'plain-text';
  snapshot(): BufferSnapshot;
  isDirty(): boolean;
  markSaved(snapshot: BufferSnapshot): void;
  discard(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
```

- Monaco adapter 用 model content-change 和 alternative/version IDs 管理保存基线；需要测试 edit -> dirty -> undo to baseline -> clean。
- Plain-text adapter 用单调 edit epoch，避免每个按键比较 20 MiB 字符串。它允许保守 false-negative 为零、false-positive 为 dirty：用户 undo 回相同内容后可能仍需 Save；这是性能优先的安全选择，须写入 evidence。
- Save 开始记录 `{content, version}`。成功只调用 `markSaved(requestSnapshot)`，让 adapter 同时保留已提交内容和版本作为 discard 基线；若用户在请求期间继续编辑，当前 version 更大，仍 dirty。
- 关闭/discard 必须先从 UI 状态移除，再 dispose 对应 buffer/model；保存失败不得 close。

### Project-scoped mutation serialization

所有 Stage 3 mutation 使用同一个项目 scope：

```ts
scope: { id: `project-file-write:${projectId}` }
```

UI 在任一文件 mutation pending 时禁用本项目其他写命令。scope 是防竞态补偿，不是授权。遇到 revision conflict 后取消尚未发出的用户流程；不要假设 TanStack 队列本身能撤销已经提交的 mutation。

### Cache rules

- Refresh 工具栏只 invalidate tree keys，不再 invalidate 当前项目全部正文。
- 所有 tree/meta/content queryFn 都向 HTTP 层传递 `AbortSignal`；测试必须证明 cancel 后迟到响应不能更新 Query Cache 或 revision。
- Save success 使用 immutable `setQueryData` 更新当前 content/meta/revision，不全量刷新，避免覆盖其他 dirty buffers。
- Create success invalidate parent tree；新文件可立即 select/open，正文 cache 写入空内容。
- Rename success cancel old queries、dispose old-path renderer、remap session paths、remove old-path queries、invalidate old parent tree，并以新路径重新读取 metadata/content。
- Delete success 先计算目标及 descendants，关闭 clean tabs、dispose models/buffers、remove target queries，再 invalidate parent tree。
- Project switch、logout、当前会话 401 保持 `cancel -> dispose resources -> reset session -> remove/clear queries` 顺序。

## Interaction Decisions

### Save

- 活动 `MONACO_TEXT` 或 `PLAIN_TEXT` 显示固定 32 px Save 图标按钮；clean 时 disabled，pending 时显示 spinner/status。
- `Ctrl+S` / `Cmd+S` 只作用于活动 buffer，调用 `preventDefault()`，dialog/input 中不误保存编辑器。
- 保存成功提供短暂 `role="status"`，标签 `*` 消失；不弹营销式 toast 堆叠。
- 保存失败在编辑区局部显示 retryable `role="alert"`，标签保持 dirty。

### Dirty close and navigation

- 关闭一个 dirty tab：`Save and close`、`Discard`、`Cancel`。Save 使用关闭动作捕获的 path，不因用户切换活动标签而保存错文件。
- 离开工作台且有任意 dirty：`Discard changes and leave`、`Cancel`。Stage 3 不做 Save All，避免多文件部分成功后仍导航的模糊语义。
- logout 使用同一 guard；Cancel 不清 auth，Discard 后调用既有 `logout()`。
- 浏览器刷新/关闭使用 `beforeunload` 标准提示；浏览器文案不可定制，不将其截图作为产品证据。
- 当前 token `401` 是安全优先的强制清理，不显示可取消的 dirty dialog。

### Create, rename and delete

- 文件树 toolbar：New file、New folder。Rename/Delete 仅在选中项时可用；无 selection 时 disabled。
- 创建目标目录：选中目录则在其内；选中文件则用其 parent；无选择则 root。
- Dialog 输入只接收 basename；允许 `.gitignore` 和 Unicode，拒绝空、`/`、`\`、`.`、`..`、NUL。最终完整路径仍调用现有 parser。
- Rename 只改 basename，不移动目录。dirty target/descendant 时命令 disabled 并有可访问原因。
- Delete 使用明确不可恢复确认，显示相对路径；目录说明可能包含后代。Cancel 零副作用。
- 不增加右键菜单、拖拽、上传或批量选择。

### Run precondition seam

Stage 3 增加纯前端派生值，供 Stage 4 复用：

```ts
type RunPreconditions = {
  canRequestRun: boolean;
  reason: 'DIRTY_FILES' | 'WRITE_PENDING' | 'REVISION_UNAVAILABLE' | 'STAGE_4_UNAVAILABLE';
};
```

生产 Run tab 仍 disabled、无 HTTP 请求、无假日志。当 dirty 存在时，accessible description 优先是 `DIRTY_FILES`；clean 后显示 Stage 4 unavailable。本 seam 只证明 UI 不会在 dirty 时产生启动意图，不等于真实 Run API 已实现。

## Target File Structure

```text
poc4/frontend/src/
├─ api/
│  ├─ fileApi.ts
│  └─ fileApi.test.ts
├─ contracts/
│  ├─ api.ts
│  └─ file.ts
├─ components/
│  ├─ files/
│  │  ├─ EditorWorkspace.tsx
│  │  ├─ EditorWorkspace.test.tsx
│  │  ├─ WritableMonacoEditor.tsx
│  │  ├─ PlainTextEditor.tsx
│  │  ├─ FileTree.tsx
│  │  ├─ FileTreeNode.tsx
│  │  ├─ FileMutationDialogs.tsx
│  │  ├─ UnsavedChangesDialog.tsx
│  │  └─ editorSaveCommand.ts
│  └─ shell/
│     ├─ WorkbenchShell.tsx
│     └─ WorkbenchShell.test.tsx
├─ features/
│  ├─ editor/
│  │  ├─ workspaceSession.ts
│  │  ├─ workspaceSession.test.ts
│  │  ├─ WorkspaceBufferRegistry.ts
│  │  ├─ WorkspaceBufferRegistry.test.ts
│  │  ├─ unsavedChangesGuard.ts
│  │  └─ runPreconditions.ts
│  ├─ files/
│  │  ├─ fileQueries.ts
│  │  ├─ fileMutations.ts
│  │  ├─ fileMutations.test.ts
│  │  └─ entryNamePolicy.ts
│  └─ projects/
│     └─ WorkbenchPage.tsx
├─ lib/
│  └─ projectMonacoModels.ts
└─ mocks/
   ├─ fileFixtures.ts
   ├─ handlers.ts
   └─ state.ts

poc4/frontend/tests/e2e/
├─ stage3.spec.ts
└─ stage3-large-writes.spec.ts

poc4/docs/evidence/stage-3/
├─ result.md
└─ chrome/edge PNG evidence
```

Renames from Stage 2 must use `git mv` during the relevant task so history remains readable. Do not rename Stage 0 Spike files or terminal artifacts.

## Task 1: Extend Stage 3 Boundaries And Runtime Contracts

**Files:**

- Modify: `poc4/frontend/scripts/browser-boundary-lib.mjs`
- Modify: `poc4/frontend/scripts/browser-boundary-lib.test.mjs`
- Modify: `poc4/frontend/scripts/check-browser-boundary.mjs`
- Modify: `poc4/frontend/src/contracts/api.ts`
- Modify: `poc4/frontend/src/contracts/file.ts`
- Modify: `poc4/frontend/src/api/httpClient.ts`
- Modify: `poc4/frontend/src/api/httpClient.test.ts`
- Modify: `poc4/frontend/src/api/fileApi.ts`
- Modify: `poc4/frontend/src/api/fileApi.test.ts`
- Create: `poc4/frontend/src/features/files/entryNamePolicy.ts`
- Create: `poc4/frontend/src/features/files/entryNamePolicy.test.ts`

- [ ] **Step 1: Write failing Stage 3 boundary tests**

Rename the Stage 2 production module classifier to a durable workbench classifier and include all new writable modules. Continue rejecting Stage 0 Spike, terminal, mocks, echo server, Node built-ins, Electron and forbidden Kubernetes/physical resource identifiers. Add forbidden production strings for the Stage 3 mock scenario endpoint.

- [ ] **Step 2: Write failing revision and mutation parser tests**

Cover empty/oversized revision, request/response path mismatch, wrong entry kind, parent mismatch, mismatched file metadata, duplicate fields that violate invariants and forbidden physical identifiers. Parsing failure remains a single safe error such as `Invalid file response`; do not render partial mutation results.

- [ ] **Step 3: Extend root tree and write contracts**

Add the exact contract shapes from this plan. Existing Stage 2 tree fixtures/tests must be updated to require `workspaceRevision`; no optional fallback and no client-generated default are allowed.

- [ ] **Step 4: Implement basename and path composition policy**

`parseEntryBasename` accepts hidden and Unicode names but rejects empty, slash, backslash, NUL, `.` and `..`. `joinProjectPath(parent, basename)` returns a branded path and is table-tested at root and nested parents. This is UX validation only.

- [ ] **Step 5: Implement exact HTTP methods and bodies**

Add `saveFileContent`, `createEntry`, `renameEntry` and `deleteEntry`. Assert encoded opaque project ID, `URLSearchParams` path behavior, Bearer header, JSON body revision and absence of token in URL/body. Extend `HttpClient` request options with `AbortSignal` and pass it unchanged to `fetch`; aborted requests must not be remapped to an ordinary retryable network error. DELETE body and abort support must both be covered by `HttpClient` tests.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/files/entryNamePolicy.test.ts src/api/fileApi.test.ts src/api/httpClient.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/scripts poc4/frontend/src/contracts poc4/frontend/src/api poc4/frontend/src/features/files/entryNamePolicy*
git -C ../.. commit -m "feat(poc4): define stage 3 file mutation contracts"
```

## Task 2: Make MSW Workspaces Mutable And Revision-Aware

**Files:**

- Modify: `poc4/frontend/src/mocks/fileFixtures.ts`
- Modify: `poc4/frontend/src/mocks/state.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`
- Modify: `poc4/frontend/src/mocks/handlers.test.ts`

- [ ] **Step 1: Write failing deterministic mutation tests**

Test root/nested create, collision, file/directory rename, descendant remap, file delete, empty directory delete, non-empty directory rejection, owner rejection, non-READY rejection, invalid path and revision mismatch. Assert exact revision sequence and that failure leaves workspace/revision unchanged.

- [ ] **Step 2: Rebuild fixtures on reset**

Replace the immutable module-level workspace maps with resettable workspace state. `resetMockState()` must restore files, directories, children, revisions, write scenario and request counters. Large body caches remain lazy and are cleared between tests.

- [ ] **Step 3: Implement opaque monotonic mock revisions**

The mock may internally use a counter but returns opaque strings such as `mock-rev-0002`. Increment exactly once after a successful mutation. Read handlers return the current token. Failed validation, auth, lock, conflict or size checks do not increment.

- [ ] **Step 4: Implement owner/READY/path/revision/lock gates in order**

Every write handler performs authentication and ownership without leaking existence, validates READY project and path, compares expected revision, checks mock lock, then mutates. Tests must not infer this order from UI; handler tests assert no mutation on every rejected branch.

- [ ] **Step 5: Implement save size/mode transitions**

Measure UTF-8 bytes with `TextEncoder`, not `string.length`. Return fresh metadata. Test Markdown at `20 MiB`, `20 MiB + 1`, `50 MiB`, `50 MiB + 1`; non-Markdown at `20 MiB` and `20 MiB + 1`. Reject blocked/binary/non-UTF-8 PUT even when called directly.

- [ ] **Step 6: Add one mock-only Stage 3 scenario endpoint**

Use one authenticated mock-only endpoint to choose normal/delayed/locked/conflict/failure behavior for E2E. It must never be imported by production modules and its literal path must be included in production-dist exclusion scans.

- [ ] **Step 7: Verify and commit**

```powershell
pnpm test -- src/mocks/handlers.test.ts src/api/fileApi.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/mocks
git -C ../.. commit -m "test(poc4): simulate revisioned file writes"
```

## Task 3: Add Workspace Buffer And Dirty Lifecycle

**Files:**

- Create: `poc4/frontend/src/features/editor/WorkspaceBufferRegistry.ts`
- Create: `poc4/frontend/src/features/editor/WorkspaceBufferRegistry.test.ts`
- Modify: `poc4/frontend/src/features/editor/editorTypes.ts`
- Modify: `poc4/frontend/src/features/editor/workspaceSession.ts`
- Modify: `poc4/frontend/src/features/editor/workspaceSession.test.ts`
- Modify: `poc4/frontend/src/runtime/WorkspaceResourceRegistry.ts`
- Modify: `poc4/frontend/src/app/appRuntime.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`
- Modify: `poc4/frontend/src/lib/projectMonacoModels.ts`
- Modify: `poc4/frontend/src/lib/projectMonacoModels.test.ts`

- [ ] **Step 1: Write failing registry tests**

Cover register once, duplicate same path, snapshot immutability, subscribe/unsubscribe, edit dirty, Monaco undo-to-baseline clean, plain-text conservative dirty, `markSaved` with the exact request snapshot, `markSaved` after later edit, discard back to the saved snapshot, rename/remap and idempotent dispose.

- [ ] **Step 2: Extend session state with lightweight dirty metadata**

Add immutable `dirtyPaths: Set<ProjectRelativePath>` and actions `setDirty`, `remapPath`, `removePathAndDescendants`. Never add content or revision to Zustand. Existing activate/reset semantics continue using `getInitialState()`.

- [ ] **Step 3: Implement project/path keyed buffer registry**

Registry keys include project ID and relative path. It owns adapters and calls the session dirty action through an injected callback rather than importing the global store. Tests prove Alice/Bob same relative path do not collide.

- [ ] **Step 4: Register disposal without statically importing Monaco into appRuntime**

Follow the existing `WorkspaceResourceRegistry` lazy-disposer boundary. Writable workbench registers buffer/model disposal after lazy load. Global `appRuntime` remains lightweight and cannot pull Monaco into the production entry chunk.

- [ ] **Step 5: Add path remap/removal helpers**

For rename/delete, handle exact path plus directory descendants with segment boundaries (`src/a` must not match `src/ab`). Test selected, active, open, expanded and dirty state transitions.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/editor src/lib/projectMonacoModels.test.ts src/app/appRuntime.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/editor poc4/frontend/src/runtime poc4/frontend/src/app poc4/frontend/src/lib
git -C ../.. commit -m "feat(poc4): manage writable workspace buffers"
```

## Task 4: Implement Revision Cache And Serialized Mutations

**Files:**

- Modify: `poc4/frontend/src/features/files/fileQueries.ts`
- Modify: `poc4/frontend/src/features/files/fileQueries.test.ts`
- Create: `poc4/frontend/src/features/files/fileMutations.ts`
- Create: `poc4/frontend/src/features/files/fileMutations.test.ts`

- [ ] **Step 1: Write failing revision cache tests**

Root tree seeds `fileKeys.revision(projectId)`. Nested tree/content can refresh it only while belonging to the current project. Project switch/removal clears old revision. No mutation may run with missing revision. Use deferred queries to prove `cancelQueries` aborts the underlying request and a late resolution cannot regress revision after a write.

- [ ] **Step 2: Split query invalidation**

Add hierarchical `trees`, `meta`, `content`, `revision` keys. Refresh invalidates only trees. Tests prove clicking Refresh while a model is dirty does not refetch content or replace buffer.

- [ ] **Step 3: Add project-scoped save/create/rename/delete mutations**

All use `scope.id = project-file-write:${projectId}` and `retry: false`. Before mutation cancel relevant project file queries. Do not optimistically mutate tree or clear dirty.

- [ ] **Step 4: Apply authoritative success atomically**

Write returned metadata/content/revision immutably, then update session/model lifecycle. Expose callbacks for close-after-save and rename/delete cleanup. Tests use deferred promises to assert exact order.

- [ ] **Step 5: Handle errors without destructive fallback**

Map network, 403, locked, revision conflict, collision, directory-not-empty, 413/415 and 5xx to stable UI messages. Do not auto-retry mutation or use a failed response body as authority. A current-token 401 continues through appRuntime cleanup.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/files/fileQueries.test.ts src/features/files/fileMutations.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/features/files
git -C ../.. commit -m "feat(poc4): serialize revisioned file mutations"
```

## Task 5: Convert Read-Only Viewers Into Writable Editors

**Files:**

- Rename: `poc4/frontend/src/components/files/ReadonlyMonacoEditor.tsx` -> `WritableMonacoEditor.tsx`
- Rename: `poc4/frontend/src/components/files/PlainTextViewer.tsx` -> `PlainTextEditor.tsx`
- Rename: `poc4/frontend/src/components/files/ReadonlyEditorWorkspace.tsx` -> `EditorWorkspace.tsx`
- Rename: `poc4/frontend/src/components/files/ReadonlyEditorWorkspace.test.tsx` -> `EditorWorkspace.test.tsx`
- Create: `poc4/frontend/src/components/files/editorSaveCommand.ts`
- Create: `poc4/frontend/src/components/files/editorSaveCommand.test.ts`
- Modify: `poc4/frontend/src/components/files/EditorTabs.tsx`
- Modify: `poc4/frontend/src/components/files/EditorTabs.test.tsx`

- [ ] **Step 1: Use `git mv` and first preserve all Stage 2 tests**

Rename components/tests without behavior change, update imports, run the existing suite, then add writable tests. This isolates regressions from the behavior conversion.

- [ ] **Step 2: Make Monaco editable through the registry**

Set `readOnly: false`, `domReadOnly: false`, register the model once, subscribe to changes and bind `CtrlCmd+S`. Keep unique project URI, Worker config, `keepCurrentModel`, view state and explicit dispose. Do not mirror every keystroke into React state.

- [ ] **Step 3: Make large Markdown editable without per-keystroke full scans**

Initialize a plain-text buffer once and render an editable textarea from it. On input, update buffer/epoch without copying into Zustand. Switching tabs unmounts/remounts from the registry snapshot. `BLOCKED` remains the existing view and never registers a buffer.

- [ ] **Step 4: Add Save command lifecycle**

Save button uses Lucide Save icon, fixed dimensions and accessible name. Capture snapshot/version before mutate. Disable duplicate save for the same project pending mutation. On success mark only the saved version; on later edit keep dirty. On failure keep buffer and alert.

- [ ] **Step 5: Handle renderer mode transitions**

When authoritative save metadata changes mode, dispose the previous adapter/model only after success, seed the new renderer from the submitted snapshot and preserve tab/selection. A rejected over-limit save must not transition renderer or discard content.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/files/EditorWorkspace.test.tsx src/components/files/EditorTabs.test.tsx src/components/files/editorSaveCommand.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add -A poc4/frontend/src/components/files
git -C ../.. commit -m "feat(poc4): edit and explicitly save workspace files"
```

## Task 6: Guard Dirty Close, Navigation And Logout

**Files:**

- Create: `poc4/frontend/src/components/files/UnsavedChangesDialog.tsx`
- Create: `poc4/frontend/src/components/files/UnsavedChangesDialog.test.tsx`
- Create: `poc4/frontend/src/features/editor/unsavedChangesGuard.ts`
- Create: `poc4/frontend/src/features/editor/unsavedChangesGuard.test.ts`
- Modify: `poc4/frontend/src/components/files/EditorWorkspace.tsx`
- Modify: `poc4/frontend/src/components/files/EditorWorkspace.test.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`

- [ ] **Step 1: Write the transition matrix before UI code**

Cover clean close, dirty Save-and-close success/failure/later-edit, Discard, Cancel, back link, browser history, logout and current-token 401. Every test asserts route/auth/tab/model/buffer consequences, not only dialog visibility.

- [ ] **Step 2: Implement one controlled native modal dialog**

Use the browser modal dialog semantics with explicit focus initialization, focus containment, Escape cancel and trigger-focus restoration. Do not add a new UI dependency. Dialog state includes target path/action so later tab switches cannot redirect the command.

- [ ] **Step 3: Guard tab close**

Clean closes immediately. Dirty opens Save/Discard/Cancel. Save failure leaves dialog and tab open; Save success closes only if the captured buffer has no later edits, otherwise dialog reports remaining changes and keeps tab open.

- [ ] **Step 4: Guard SPA navigation and logout**

Use the installed React Router navigation blocker for workbench route transitions and explicit interception for logout. Confirm/discard resets resources before proceeding. Implementation must refresh React Router 8.3.0 API docs at execution time before coding this step because router blocker APIs are version-sensitive.

- [ ] **Step 5: Add `beforeunload` only while dirty exists**

Register and remove one listener based on dirty count. Do not install it for clean sessions, do not persist buffers, and do not attempt custom browser prompt text.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/editor/unsavedChangesGuard.test.ts src/components/files/UnsavedChangesDialog.test.tsx src/components/files/EditorWorkspace.test.tsx src/components/shell/WorkbenchShell.test.tsx
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components poc4/frontend/src/features
git -C ../.. commit -m "feat(poc4): guard unsaved workspace changes"
```

## Task 7: Add Create File And Directory Commands

**Files:**

- Rename: `poc4/frontend/src/components/files/ReadonlyFileTree.tsx` -> `FileTree.tsx`
- Rename: `poc4/frontend/src/components/files/ReadonlyFileTree.test.tsx` -> `FileTree.test.tsx`
- Create: `poc4/frontend/src/components/files/FileMutationDialogs.tsx`
- Create: `poc4/frontend/src/components/files/FileMutationDialogs.test.tsx`
- Modify: `poc4/frontend/src/components/files/FileTreeNode.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.test.tsx`

- [ ] **Step 1: Rename with behavior-preserving tests**

Use `git mv`, update imports, and keep lazy-load, sorting, roving tabindex, hidden-file and Stage 2 error tests green before adding commands.

- [ ] **Step 2: Add stable toolbar controls**

Add New file and New folder icon buttons beside Refresh/Collapse. Keep 32 px fixed boxes and 256 px sidebar width. Selection determines parent exactly as specified; disabled/pending state does not resize toolbar.

- [ ] **Step 3: Add accessible basename dialog**

Label input, focus it on open, submit with Enter, cancel with Escape, show local validation before request and server error without closing. No full relative-path free typing.

- [ ] **Step 4: Apply create success**

Invalidate only parent tree, expand parent, select new entry. For file, seed empty content/meta cache and open the new tab; for directory, select/expand it without requesting unrelated directories.

- [ ] **Step 5: Verify collision, lock and conflict behavior**

All preserve dialog input and current selection, keep revision unchanged and make zero fake tree mutations. Retry requires an explicit user action.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/files/FileTree.test.tsx src/components/files/FileMutationDialogs.test.tsx src/features/files/fileMutations.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add -A poc4/frontend/src/components/files
git -C ../.. commit -m "feat(poc4): create workspace files and directories"
```

## Task 8: Add Rename And Confirmed Delete Consistency

**Files:**

- Modify: `poc4/frontend/src/components/files/FileMutationDialogs.tsx`
- Modify: `poc4/frontend/src/components/files/FileMutationDialogs.test.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.tsx`
- Modify: `poc4/frontend/src/components/files/FileTree.test.tsx`
- Modify: `poc4/frontend/src/components/files/EditorWorkspace.tsx`
- Modify: `poc4/frontend/src/features/editor/workspaceSession.ts`
- Modify: `poc4/frontend/src/features/editor/workspaceSession.test.ts`
- Modify: `poc4/frontend/src/features/files/fileMutations.ts`
- Modify: `poc4/frontend/src/features/files/fileMutations.test.ts`

- [ ] **Step 1: Write rename/delete state matrix tests**

Include clean closed file, clean open file, directory with open descendants, selected/expanded descendants, exact prefix collision (`src/a` vs `src/ab`), dirty target, dirty descendant, delete cancel, non-empty rejection, locked/conflict and success.

- [ ] **Step 2: Implement same-parent rename**

Dialog shows current basename selected. Server response is authoritative. On success dispose old-path resources, remap all session paths by segment-safe suffix, remove old queries, invalidate parent and reload new path. No dirty target can enter mutation.

- [ ] **Step 3: Implement irreversible delete confirmation**

Show file/directory icon and exact relative path. Default focus is Cancel. Confirm button uses destructive styling but stable size. Dirty target/descendant blocks opening the destructive request and points user back to save/discard.

- [ ] **Step 4: Apply delete success in safe order**

Capture target descendants, remove UI references, dispose buffers/models, remove old query keys, then invalidate parent tree. Cancel or failure performs none of those steps.

- [ ] **Step 5: Test non-empty directory policy honestly**

Default mock returns `DIRECTORY_NOT_EMPTY`; a dedicated scenario may verify a confirmed recursive response and descendant cleanup. Evidence must state this is a front-end contract, not proof of real backend recursive-delete safety.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/components/files/FileTree.test.tsx src/components/files/FileMutationDialogs.test.tsx src/features/editor/workspaceSession.test.ts src/features/files/fileMutations.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/src/components/files poc4/frontend/src/features
git -C ../.. commit -m "feat(poc4): rename and delete workspace entries"
```

## Task 9: Assemble Writable Workbench And Run Preconditions

**Files:**

- Rename: `poc4/frontend/src/features/projects/ReadonlyWorkbenchPage.tsx` -> `WorkbenchPage.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectRoutePage.tsx`
- Modify: `poc4/frontend/src/features/projects/ProjectsPage.test.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.test.tsx`
- Create: `poc4/frontend/src/features/editor/runPreconditions.ts`
- Create: `poc4/frontend/src/features/editor/runPreconditions.test.ts`
- Modify: `poc4/frontend/src/app/appRuntime.test.ts`

- [ ] **Step 1: Rename the lazy route without losing code splitting**

Use `git mv`; `ProjectRoutePage` still dynamically imports the workbench. Production entry must remain free of Monaco. Update boundary classifier and lazy-load tests.

- [ ] **Step 2: Wire writable tree/editor and global pending state**

Workbench Shell receives no physical identifiers. Toolbar commands share project mutation pending state and unsaved guard. Run/Terminal do not render fake panels or import Stage 0 modules.

- [ ] **Step 3: Implement and test Run precondition seam**

Dirty, write pending or missing revision each produce the exact disabled reason. Clean/revision-ready still yields `STAGE_4_UNAVAILABLE` because there is no Run endpoint. Test that no `/runs` request occurs.

- [ ] **Step 4: Verify lock/conflict UI honesty**

`PROJECT_LOCKED` and revision conflict alerts must not claim a Run ID/state or successful reload. Keep dirty content visible. The action can return to projects or let the user explicitly discard/reload, but cannot silently fetch and overwrite.

- [ ] **Step 5: Verify session cleanup and stale 401 again**

Logout after discard, project transition, current-token 401 and Alice-late-401-after-Bob-login must close/dispose the correct buffers/models and never leak one user's file content into another project.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test -- src/features/editor/runPreconditions.test.ts src/components/shell/WorkbenchShell.test.tsx src/features/projects/ProjectsPage.test.tsx src/app/appRuntime.test.ts
pnpm typecheck
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add -A poc4/frontend/src/features/projects poc4/frontend/src/components/shell poc4/frontend/src/features/editor poc4/frontend/src/app
git -C ../.. commit -m "feat(poc4): assemble the writable project workbench"
```

## Task 10: Add Stage 3 Browser, Visual And Large-Write Evidence

**Files:**

- Create: `poc4/frontend/tests/e2e/stage3.spec.ts`
- Create: `poc4/frontend/tests/e2e/stage3-large-writes.spec.ts`
- Modify: `poc4/frontend/playwright.config.ts`
- Modify: `poc4/frontend/package.json`
- Modify: `poc4/frontend/README.md`
- Create: `poc4/docs/evidence/stage-3/chrome-dirty-1280x720.png`
- Create: `poc4/docs/evidence/stage-3/chrome-dirty-1440x900.png`
- Create: `poc4/docs/evidence/stage-3/chrome-dirty-1920x1080.png`
- Create: `poc4/docs/evidence/stage-3/chrome-delete-dialog-1280x720.png`
- Create: `poc4/docs/evidence/stage-3/chrome-delete-dialog-1440x900.png`
- Create: `poc4/docs/evidence/stage-3/chrome-delete-dialog-1920x1080.png`
- Create: matching six Edge PNG files

- [ ] **Step 1: Add functional E2E without screenshots**

At minimum cover:

1. edit Monaco -> dirty -> tab switch -> return -> buffer preserved;
2. `Ctrl+S` exact relative PUT + Bearer + expected revision -> clean;
3. edit while delayed save pending -> first snapshot saved -> newer edit remains dirty;
4. network/locked/conflict/413 failure -> dirty and content preserved;
5. dirty close Cancel, Discard and Save-and-close;
6. back/logout navigation guard Cancel and Discard;
7. create root/nested file and directory with lazy tree counts;
8. rename open file and directory descendants without stale old paths;
9. delete cancel, non-empty rejection and confirmed cleanup;
10. refresh while dirty does not replace editor;
11. blocked file remains zero PUT/content bypass rejected;
12. Alice/Bob project switch and stale 401 isolation;
13. no production Run/log/terminal requests.

- [ ] **Step 2: Add dedicated large-write project and 180-second ceiling**

Add a Playwright project that runs only `stage3-large-writes.spec.ts`. Enable real bodies, open `docs/large-notes.md` at `20 MiB + 1`, edit a bounded suffix, switch away/back, save, verify exact request content length/UTF-8 byte length, new revision, dirty clear and persisted refetch. Record click-to-ready and save-start-to-response. Treat crash, timeout, page error or response truncation as Stage 3 failure.

Optionally test near-limit Monaco save only if stable memory remains below the test machine limit; it cannot replace the required large Markdown write.

- [ ] **Step 3: Add Chrome/Edge screenshots and geometry assertions**

Capture dirty workbench and delete dialog at 1280x720, 1440x900 and 1920x1080. Assert no document horizontal overflow, toolbar controls reachable, tab text/dirty marker not clipped incoherently, modal inside viewport, destructive and cancel controls visible, editor canvas nonblank and no overlap.

- [ ] **Step 4: Add keyboard/accessibility assertions**

Keyboard-only path must reach tree toolbar, create dialog, editor, Save, tabs, close dialog and delete confirmation. Assert modal focus containment/return, Escape cancel, error announcement, success status, dirty not color-only and reduced-motion behavior.

- [ ] **Step 5: Update README and scripts**

Add `test:e2e:large-writes` using pnpm. README must describe Stage 3 mock-only boundary, writable modes, revision semantics, dirty guard and known limitation that Run authority is still absent. Do not present mock credentials as production.

- [ ] **Step 6: Verify and commit**

```powershell
pnpm test:e2e
pnpm test:e2e:large-writes
pnpm test:e2e:channels
git -C ../.. diff --check
git -C ../.. add poc4/frontend/tests poc4/frontend/playwright.config.ts poc4/frontend/package.json poc4/frontend/README.md poc4/docs/evidence/stage-3
git -C ../.. commit -m "test(poc4): verify stage 3 writable workbench"
```

If channel screenshot commands rewrite committed Stage 0/2 PNG files, restore only those known recaptures after confirming paths. Do not touch user files or `.grok/`.

## Task 11: Final Verification And Stage 3 Evidence Report

**Files:**

- Create: `poc4/docs/evidence/stage-3/result.md`

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
```

Run from `poc4/frontend`. Record command, exit code, exact test counts, duration and source SHA. If E2E overwrites `dist`, run `pnpm build` again before production scanning.

- [ ] **Step 2: Scan production output**

Require zero UTF-8-decoded matches for all Stage 2 needles plus the exact Stage 3 scenario endpoint and any mock write fixture marker. Confirm `dist/stage0.html` and `dist/mockServiceWorker.js` absent, production route still contains Monaco workers, and entry chunk still has no Monaco static import.

- [ ] **Step 3: Record revision and dirty evidence**

Include request/response examples with secrets redacted, initial/success/failure revision transitions, delayed-save edit behavior, cache/model disposal ordering and all error outcomes. Explicitly distinguish client behavior from real backend guarantees.

- [ ] **Step 4: Record CRUD and navigation evidence**

Document create/rename/delete path traces, dirty descendant blocks, dialog focus behavior, cancellation zero side effects, project/logout/401 cleanup and no `/runs` requests.

- [ ] **Step 5: Record real-size measurements and visuals**

For each large write record actual string length, UTF-8 request bytes, response bytes if available, viewer-ready time, save time, page/console errors and browser version. List all PNG dimensions and 1280 px geometry assertions.

- [ ] **Step 6: Verify repository hygiene**

```powershell
git -C ../.. diff --check
git -C ../.. status --short
```

Also strictly decode tracked text under `poc4/frontend` and `poc4/docs` as UTF-8, count BOMs and report CR presence under the repository's current `core.autocrlf=true`. Do not add `.grok/`, `.worktree/`, traces, videos, `test-results/`, `playwright-report/` or recaptured prior-stage PNGs.

- [ ] **Step 7: Make the decision**

Only when all 13 exit gates pass, write:

```text
READY_FOR_STAGE_4_PLAN
```

Otherwise write:

```text
STAGE_3_REMEDIATION_REQUIRED
```

List every failed gate and do not start Stage 4 planning.

- [ ] **Step 8: Commit the report**

```powershell
git -C ../.. add poc4/docs/evidence/stage-3/result.md poc4/frontend/README.md
git -C ../.. commit -m "docs(poc4): record stage 3 writable workbench result"
```

## Verification Matrix

| Layer | Required evidence |
|---|---|
| Contract | Runtime parser rejects malformed revision/path/entry/metadata; exact HTTP methods and bodies |
| Mock handler | Owner, READY, path, revision, lock, collision, type, byte-size and atomic failure behavior |
| Buffer | Monaco/plain dirty lifecycle, delayed-save edit, discard, dispose, project isolation |
| Cache | root revision seed, tree-only refresh, mutation success updates, failure no mutation, remap/remove |
| Component | Save, dialogs, CRUD, focus, local errors, blocked mode, Run disabled reason |
| Chromium | Full Stage 1/2/3 functional regression plus Stage 0 isolation tests |
| Chrome/Edge | Same core functional workflows and 12 Stage 3 screenshots |
| Large write | Real `20 MiB + 1` UTF-8 Markdown edit/save/refetch under 180 seconds |
| Production | mock/credential/scenario/echo/Spike zero matches; lazy Monaco preserved |
| Hygiene | typecheck, all tests, build, diff check, UTF-8 strict, BOM zero, clean scoped status |

## Acceptance Traceability

| POC4 rule | Stage 3 proof | Still deferred |
|---|---|---|
| Explicit save / `Ctrl+S` | Writable editors + snapshot/version mutation tests + browser E2E | Real backend atomic PVC write |
| Unsaved blocks run | Dirty-derived Run precondition and zero `/runs` request | Real Run endpoint and server revision check |
| Create/rename/confirmed delete | Relative-path contracts, dialogs, mock mutation and cache/model cleanup | Real filesystem semantics and symlink safety |
| Run-time writes rejected | `409 PROJECT_LOCKED` mock contract preserves dirty | Active Run authority and proactive UI lock |
| workspace revision | Root seed, every mutation expected token, success advance, conflict no overwrite | Real transaction/locking implementation |
| 20/50 MiB policy | Save byte boundary tests and real large Markdown write | NFS/Pod latency and production SLA |
| User/project isolation | Token/project scoped cache, buffer, mutations and stale 401 tests | Real JWT/ownership/PVC isolation |
| Browser boundary | source and production scans | Full backend threat-model verification |

## Known Risks Carried Forward

1. **真实后端仍是最大证据缺口。** Stage 3 可以稳定浏览器合同，但不能证明原子 rename/write、symlink 防护、锁或 owner checks。
2. **revision 聚合可能产生保守冲突。** Opaque revision 无法在客户端排序；旧 GET 被 cancel 但网络竞态仍可能导致后端拒绝。拒绝比错误覆盖安全，真实合同需后端集成验证。
3. **大文本编辑有内存放大。** Query baseline、编辑 buffer、JSON request 和浏览器内部字符串可能同时存在。真实 20 MiB+1 测试只证明当前机器可用，不是 SLA。
4. **plain-text dirty 是保守的。** 为避免每次输入扫描几十 MiB，undo 回完全相同内容可能仍显示 dirty；用户可 Save 清除，不会造成未保存内容被误判为 clean。
5. **目录 rename/delete 的状态映射复杂。** 必须用 segment-safe descendant 逻辑并在成功后重新查询，不能靠字符串 prefix 或乐观 DOM 改名。
6. **401 与 dirty 的安全取舍。** 当前 token 失效必须立即清理会话和资源，无法保证保留未保存内容；其他错误必须保留。
7. **Run 核心闭环尚未完成。** Stage 3 只留下 precondition seam 与写拒绝处理，Stage 4 才能验证权威锁、启动/停止和终态刷新。
8. **React Router blocker API 版本敏感。** 实施 Task 6 前必须用 Context7 重新核对安装的 8.3.0 API，不能照搬旧版本示例。

## Rollback Boundaries

每个 task 都有独立提交。若某项失败，优先回退对应 task，不改动已经通过的 Stage 2 基线：

- Contract/MSW 失败：回退 Task 1-2，不触碰只读 UI。
- Buffer/dirty 失败：回退 Task 3-5，Stage 2 查看器仍可恢复。
- Navigation guard 失败：回退 Task 6，不削弱保存正确性。
- CRUD 失败：回退 Task 7-8，保留已通过的显式保存。
- Assembly/E2E 失败：修复 Task 9-10，不通过降低退出门或把 mock 称为真实集成来放行。

不得通过删除 Stage 2 测试、提高 Vite chunk warning limit、跳过 Chrome/Edge、缩小 large-write 字节量或把 `PROJECT_LOCKED` 只做按钮 disabled 来获得绿色结果。

## Execution Start Condition

执行前必须：

1. 确认 Stage 2 result 提交已在目标基线，且 decision 为 `READY_FOR_STAGE_3_PLAN`。
2. 本计划经过用户确认并提交到 `master`。
3. 从该提交创建隔离工作树和 `codex/poc4-stage-3-writable-workbench` 分支。
4. 记录 EnsoAI 来源仍为 `D:\DeepLearning\MyProjects\Enso_AI@5aa294a`；Stage 3 不再复制新的 EnsoAI 大组件，主要复用既有主题、tabs、icons 和布局。
5. 保留主工作区 `.grok/` 未跟踪目录，不修改、不提交。
6. 执行只从 Task 1 开始；不得自动进入 Stage 4。
