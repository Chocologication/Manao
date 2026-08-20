# POC4 EnsoAI 前端组件复用设计

## 1. 文档状态

- 状态：设计已确认，书面文档待审阅
- 日期：2026-08-20
- 目标：在不修改 POC4 核心规则的前提下，选择性迁移 EnsoAI 的前端设计系统、通用组件和 IDE 交互，降低浏览器工作台的实现成本。
- 后续步骤：本文经用户审阅后，另行编写详细实施计划；本文不授权直接编码。

## 2. 决策摘要

采用“受控抽取并重新组装”，不整体移植 EnsoAI renderer，也不建立共享组件包。

- POC4 保持纯浏览器 Web 应用，只通过 HTTPS 和 WebSocket 访问主后端。
- 迁移 EnsoAI 的视觉语言、必要 UI primitives 和细粒度展示组件。
- 重写文件、运行、日志和终端的数据访问与生命周期层。
- 不迁移 Electron、Preload、IPC、`node-pty`、Git、Worktree 或 AI Agent 能力。
- 迁移完成后由 POC4 独立维护，不再跟随 EnsoAI 更新。
- 首期支持最新版桌面 Chrome 和 Edge，最低目标宽度为 1280 px，不支持移动端。

这个方案预计节省 POC4 前端约 25%--40% 的工程量。该区间是基于当前源码耦合情况的工程判断，不是经过实施计量的事实；阶段 0 Spike 将验证它是否成立。

## 3. 已确认约束

以下规则来自 `poc4/docs/plan.md`，在本设计中不可修改：

1. 浏览器不能直接访问 PVC、Pod、Job 或 Kubernetes API，只能访问主后端。
2. 使用短期 JWT；所有项目和资源操作均由后端校验用户所有权。
3. 文件接口只接受项目内相对路径，不向浏览器暴露集群内绝对路径。
4. 文件采用显式保存；存在未保存模型时禁止启动运行。
5. 每个项目最多一个活动 Job；运行期间禁止编辑。
6. Job 固定执行 `mvn clean test`，最长运行 30 分钟，并允许手动停止。
7. Job 结束或终止后必须强制重新加载工作区，完成前不能解锁编辑。
8. 日志先持久化再推送，每次运行保留最近 5 MiB，并支持刷新和断线恢复。
9. 终端只能连接当前活动 Maven Job；断线即关闭旧会话，并记录命令审计。
10. 本阶段不包含 Git、上传、拖拽、批量操作、项目删除、多人协作或 AI 功能。

## 4. 证据基线

### 4.1 EnsoAI 来源

- 本地仓库：`D:\DeepLearning\MyProjects\Enso_AI`
- 评估分支：`main`
- 评估提交：`5aa294a`（2026-08-11，版本 0.2.45）
- 许可证：MIT
- 技术栈：React 19、TypeScript、Vite 7、Tailwind CSS 4、TanStack Query、Zustand、Monaco Editor、xterm.js、Lucide React。

迁移实质代码时必须保留 EnsoAI 的版权和 MIT 许可证声明，并在 POC4 中记录迁移来源提交。

### 4.2 静态盘点结果

- EnsoAI `src/renderer` 下共有 329 个 TypeScript/TSX 文件。
- 其中 92 个文件直接引用 `window.electronAPI`。
- `components/ui` 下有 56 个 TSX 文件，未发现直接 Electron 调用，但部分组件仍依赖 EnsoAI 的 store 或 macOS 窗口逻辑，因此不能整目录无审查复制。
- `FileTree.tsx` 约 1742 行，包含 24 处 Electron 调用，并混合 Git、本地路径和拖拽逻辑。
- `EditorArea.tsx` 约 1422 行，包含 Electron 文件写入、Agent 选区同步和本地编辑器能力。
- `useXterm.ts` 约 881 行，包含 25 处 Electron 调用，并直接管理本机 PTY。

由此得出的边界是：复用显示层和细粒度交互，重建资源访问层和业务调度层。

## 5. 备选方案与决定

| 方案 | 初期速度 | 长期风险 | 结论 |
|---|---:|---:|---|
| 受控抽取并重新组装 | 中高 | 低至中 | 采用 |
| 整体复制 renderer 后删减 | 表面较快 | 很高 | 放弃 |
| 仅参考外观重新实现 | 较慢 | 最低 | 不采用，节省不足 |

整体复制 renderer 的主要问题不是构建失败，而是隐藏语义仍然成立：本机绝对路径、本机 PTY、Electron 生命周期、Git/Worktree 上下文和长期挂载状态。这些假设即使能编译，也可能破坏 POC4 的授权、运行锁和终端会话规则。

## 6. 目标前端架构

```text
poc4/frontend/src/
├─ app/
│  ├─ App.tsx
│  ├─ routes.tsx
│  └─ providers.tsx
├─ api/
│  ├─ httpClient.ts
│  ├─ authApi.ts
│  ├─ projectApi.ts
│  ├─ fileApi.ts
│  ├─ runApi.ts
│  ├─ logStream.ts
│  └─ terminalStream.ts
├─ contracts/
│  ├─ auth.ts
│  ├─ project.ts
│  ├─ file.ts
│  ├─ run.ts
│  └─ websocket.ts
├─ components/
│  ├─ ui/
│  ├─ shell/
│  ├─ projects/
│  ├─ files/
│  ├─ runs/
│  └─ terminal/
├─ stores/
│  ├─ auth.ts
│  ├─ workspace.ts
│  ├─ editor.ts
│  └─ run.ts
└─ lib/
   ├─ monacoSetup.ts
   ├─ monacoTheme.ts
   ├─ fileIcons.tsx
   ├─ motion.ts
   └─ relativePath.ts
```

### 6.1 状态职责

- TanStack Query 管理服务端资源：当前用户、项目、文件树、文件内容、Run 和历史日志。
- Zustand 管理浏览器会话状态：打开的标签页、脏模型、活动面板、展开目录和面板尺寸。
- 后端 Run 状态是运行锁的唯一权威来源。
- 前端 store 不保存 PVC、Pod、Job、ServiceAccount 或命名空间标识。
- 组件通过明确的 gateway/transport 接口访问数据，不直接拼接 HTTP 或 WebSocket 协议。

## 7. 迁移清单

### 7.1 允许迁移

以下内容经过依赖审查后可以原样或轻量修改迁移：

- `globals.css` 中的主题变量、排版和基础样式。
- `lib/utils.ts` 中的 `cn`。
- `lib/motion.ts` 中与浏览器无关的动画配置。
- 必要的 Button、Menu、Dialog、Tabs、Tooltip、ScrollArea、Toast、Input、Empty、Spinner 等 UI primitives。
- `fileIcons.tsx`。
- `TerminalSearchBar.tsx`。
- `ResizeHandle.tsx`。
- `EditorTabs.tsx` 的视觉和排序交互，但需要替换类型、i18n 和 Toast 依赖。
- Monaco 主题和本地 Worker 配置中纯浏览器可用的部分。

只迁移 POC4 实际使用的 UI primitives，不复制全部 56 个组件。

### 7.2 必须拆分重写

| EnsoAI 模块 | 保留 | 删除或重写 |
|---|---|---|
| `FileTree.tsx` | 树节点、展开、选中、右键菜单、图标 | Git 装饰、拖拽、本地绝对路径、Electron 文件调用 |
| `EditorArea.tsx` | Monaco、标签页、视图状态、显式保存交互 | Agent、Git blame、自动保存、本地文件写入、Markdown 实时预览 |
| `ShellTerminal.tsx` / `useXterm.ts` | xterm 渲染、搜索、fit、WebGL 降级 | IPC、`node-pty`、本机环境、文件链接解析、旧 PTY 复用 |
| 工作台布局 | EnsoAI 的密度、顶部切换、可调整面板 | Git、Worktree、Agent、桌面窗口控件 |

### 7.3 禁止迁移

- `src/main` 和 `src/preload`。
- `window.electronAPI` 及其类型声明。
- Electron、`node-pty`、`electron-vite`、`electron-log`。
- Git、Worktree、Agent、Source Control、Todo 和本地应用打开逻辑。
- 本地文件监视、绝对路径、系统 HOME、平台检测和 macOS traffic lights 逻辑。

## 8. 页面与组件设计

```text
登录页
  └─ 项目列表 / 创建项目
       └─ POC4 工作台
            ├─ 左侧：当前项目文件树
            ├─ 顶部：File / Run / Terminal 面板切换
            ├─ File：Monaco 多标签编辑器
            ├─ Run：运行状态、启动/停止和持久化日志
            └─ Terminal：当前活动 Job 的 WebSocket PTY
```

工作台尽量保持 EnsoAI 的视觉密度、顶部面板切换、文件树、编辑器 Tabs 和终端交互，但不保留不属于 POC4 的空入口。

### 8.1 组件边界

```ts
type WorkbenchLock = {
  isEditingLocked: boolean;
  activeRunId: string | null;
  runStatus: RunStatus | null;
};

type FileActions = {
  openFile(path: ProjectRelativePath): void;
  saveFile(path: ProjectRelativePath, content: string): Promise<void>;
  createFile(path: ProjectRelativePath): Promise<void>;
  createDirectory(path: ProjectRelativePath): Promise<void>;
  rename(path: ProjectRelativePath, nextPath: ProjectRelativePath): Promise<void>;
  delete(path: ProjectRelativePath): Promise<void>;
};
```

- `ProjectRelativePath` 只表示项目内相对路径。
- 前端的路径检查用于尽早反馈，不能替代后端规范化和逃逸检查。
- 文件组件只依赖 `FileActions`，不知道 PVC 或 Kubernetes。
- 所有写操作同时受 UI 锁和后端锁保护。
- 日志与终端是两个独立组件和数据通道，Shell 输出不得进入 Run 日志。

## 9. HTTP 契约

```text
POST   /api/v1/auth/login
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{projectId}

GET    /api/v1/projects/{projectId}/files/tree?path={relativePath}
GET    /api/v1/projects/{projectId}/files/meta?path={relativePath}
GET    /api/v1/projects/{projectId}/files/content?path={relativePath}
PUT    /api/v1/projects/{projectId}/files/content?path={relativePath}
POST   /api/v1/projects/{projectId}/entries
POST   /api/v1/projects/{projectId}/entries/rename
DELETE /api/v1/projects/{projectId}/entries?path={relativePath}

GET    /api/v1/projects/{projectId}/runs/active
GET    /api/v1/projects/{projectId}/runs
POST   /api/v1/projects/{projectId}/runs
POST   /api/v1/projects/{projectId}/runs/{runId}/stop

POST   /api/v1/projects/{projectId}/runs/{runId}/log-ticket
POST   /api/v1/projects/{projectId}/runs/{runId}/terminal-sessions
GET    /api/v1/projects/{projectId}/runs/{runId}/terminal-audits
```

`projectId` 是浏览器选择项目所需的不透明业务 ID。后端不能信任它，必须以 JWT 用户身份重新校验该项目的所有权。接口中不得出现 PVC、Pod 或 Job 名称。

### 9.1 写入与运行约束

- 文件接口只接受相对路径。
- 启动接口不接受任意命令或镜像，后端固定使用 `mvn clean test` 和固定镜像。
- 资源配置由后端独立验证，不能超过 `8 CPU / 16 GiB / 10 GiB`。
- 运行期间所有文件写操作返回 `409 PROJECT_LOCKED`。
- 重复启动返回 `409 RUN_ALREADY_ACTIVE`。
- 停止接口幂等，重复请求返回当前权威状态。
- 保存成功返回新的 `workspaceRevision`。
- 启动请求携带前端最后确认的 `workspaceRevision`；不匹配时返回 `409 RUN_STATE_CONFLICT`，前端刷新状态，不自动覆盖。
- 创建项目先返回 `CREATING`，只有 `READY` 后才能进入编辑器；失败进入 `FAILED` 并显示后端原因。

### 9.2 统一错误

```ts
type ApiError = {
  code:
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'INVALID_PATH'
    | 'FILE_TOO_LARGE'
    | 'BINARY_FILE'
    | 'PROJECT_LOCKED'
    | 'RUN_ALREADY_ACTIVE'
    | 'RUN_STATE_CONFLICT'
    | 'TERMINAL_NOT_AVAILABLE';
  message: string;
  traceId: string;
  currentState?: ProjectState | RunState;
};
```

- `401`：关闭所有 WebSocket，清理短期凭据并返回登录页。
- `403`：显示拒绝访问，不猜测资源是否存在。
- `409`：采用服务端返回的权威状态刷新本地状态，不自动重试写入。
- 网络错误：保留未保存模型并明确显示失败；不得把失败保存标记为已保存。

## 10. WebSocket 契约

浏览器原生 WebSocket 无法可靠设置自定义 `Authorization` Header，因此不把主 JWT 长期放在 URL 中。日志和终端均先通过带 JWT 的 HTTP 请求获取约 30 秒有效、单次使用、绑定用户/项目/Run 的 ticket，再建立 WSS。

### 10.1 日志流

```text
请求单次 log ticket
  -> 建立 WSS
  -> 客户端提交 lastSeq
  -> 服务端补发已持久化缺口
  -> 转入实时推送
```

```ts
type LogEvent =
  | {
      type: 'log.replay';
      chunks: LogChunk[];
      truncated: boolean;
      evictedBytes: number;
    }
  | { type: 'log.append'; seq: number; text: string }
  | { type: 'run.state'; state: RunState; reason?: string }
  | { type: 'stream.error'; code: string; retryable: boolean };
```

- 每个持久化日志片段有单调递增的 `seq`。
- 前端按 `seq` 去重和补缺，不按到达时间推断顺序。
- 日志断线不代表 Run 结束，也不能触发解锁。
- 超过 5 MiB 时必须显示 `truncated` 和 `evictedBytes`。

### 10.2 终端流

HTTP 创建终端会话前，后端必须确认用户所有权、Run 为 `RUNNING`，且目标是当前活动 Maven Job 的应用容器。

```ts
type TerminalClientControl =
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.close' };

type TerminalServerControl =
  | { type: 'terminal.ready'; sessionId: string }
  | { type: 'terminal.exit'; exitCode: number | null }
  | { type: 'terminal.error'; code: string };
```

- 终端字节流与控制消息分开编码。
- xterm `onData` 发送输入，服务端输出写入 xterm，FitAddon 的列行变化发送 resize。
- WebSocket 断开、页面关闭、Run 结束或用户关闭终端时，后端立即销毁旧 exec。
- 同一 Run 可重新创建新终端会话，但不能恢复旧会话。
- xterm 实例 `dispose()` 后不得复用。

### 10.3 命令审计边界

不能通过解析浏览器按键流可靠审计命令。退格、补全、多行输入和交互式程序会使前端推断失真。命令审计必须由容器内 Shell 集成或后端 PTY 包装层产生结构化事件，前端只查询和展示审计结果。

该实现属于后端设计的待验证项，但不能通过降低审计要求来绕过。

## 11. 状态机

### 11.1 后端 Run 状态

```text
STARTING -> RUNNING -> STOPPING -> CANCELLED
    |          |          |
    |          |          +----> FAILED
    |          +---------------> SUCCEEDED | FAILED | TIMED_OUT
    +--------------------------> FAILED

STARTING | RUNNING | STOPPING
  -> RECOVERING
  -> 恢复到对应权威状态或明确失败终态
```

后端状态为锁定依据。`STARTING`、`RUNNING`、`STOPPING` 和 `RECOVERING` 均锁定编辑。

### 11.2 前端 Workbench 阶段

```text
LOADING_AUTHORITY
  -> EDITABLE
  -> STARTING | RUNNING | STOPPING | RECOVERING
  -> RELOADING_WORKSPACE
  -> EDITABLE
```

- 页面初次加载先进入 `LOADING_AUTHORITY` 并锁定编辑，查询 active Run 后再决定状态。
- Run 到达终态时，前端关闭终端和实时日志订阅，进入 `RELOADING_WORKSPACE`。
- 前端清理 Monaco models，重新获取文件树和所有已打开文件。
- 强制重载成功后才能进入 `EDITABLE`。
- 强制重载失败时保持锁定，并提供重试；不能因为 Run 已终止而直接解锁陈旧模型。
- 未保存标签存在时，启动按钮禁用；后端仍通过 `workspaceRevision` 防止过期启动。

## 12. 实施阶段与退出条件

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| 0. 浏览器兼容性 Spike | Vite 工程、主题、必要 UI、Tabs、最小 Monaco、最小 xterm | `pnpm build` 通过；Chrome/Edge 可用；零 Electron 引用 |
| 1. 前端基础 | 路由、登录、项目列表、创建状态、全局错误 | JWT 过期正确退出；项目状态完整 |
| 2. 只读工作台 | EnsoAI 风格 Shell、文件树、多标签 Monaco、大小分级 | 只传相对路径；二进制和超限文件不进入 Monaco |
| 3. 文件写入 | 保存、新建、重命名、删除、dirty、revision | 未保存禁止运行；后端锁定可验证 |
| 4. Run 与日志 | 启动/停止、状态机、replay/live、断线恢复 | 5 MiB 截断可见；刷新不丢窗口；断线不解锁 |
| 5. 活动 Job 终端 | xterm WebSocket PTY、resize、关闭、新会话 | 断线销毁旧会话；Run 结束后不能输入 |
| 6. 恢复与验收 | 后端重启、强制刷新、安全测试、真实集群 E2E | `plan.md` 七条通过标准均有证据 |

每个阶段必须能独立构建和演示。不能等全部功能完成后才进行第一次集成。

## 13. 测试设计

### 13.1 单元和组件测试

- `ProjectRelativePath` 的拒绝规则和编码。
- dirty tabs、显式保存和保存失败。
- Run 状态 reducer 和编辑锁。
- 日志 `seq` 去重、补缺、截断提示和重连游标。
- xterm create/resize/close/dispose 生命周期。
- 文件树 CRUD、删除确认、项目创建状态和错误提示。

### 13.2 契约和浏览器测试

- 使用 MSW 和可控 WebSocket 服务验证 HTTP 错误、日志 replay、重复/乱序事件和重连。
- 使用 Playwright 覆盖登录、创建项目、编辑保存、启动、停止、日志恢复、终端关闭和页面刷新恢复。
- 固定 1280 x 720、1440 x 900、1920 x 1080 做视觉回归。
- 在 Chrome 和 Edge 当前稳定版运行核心 E2E。

### 13.3 后端和真实集群测试

- 两个用户之间的项目隔离。
- 伪造 projectId、相对路径、PVC、Pod 或 Job 标识。
- 运行期文件写入和重复启动。
- CPU、内存、临时存储和 30 分钟超时。
- 日志持久化后推送、5 MiB 淘汰和七天清理。
- 终端断线关闭和命令审计。
- 后端在活动 Run 中重启后的状态、锁和日志恢复。

前端测试不能代替这些安全与集群测试。

### 13.4 性能验证

- 接近 20 MiB 的普通文本文件。
- 20--50 MiB Markdown 的纯文本降级。
- 5 MiB 日志窗口和持续追加。
- 持续终端输出、频繁 resize 和 WebGL 到 DOM 的降级。

不在完成这些实测前声称大文件和持续输出达到可用性能。

## 14. 迁移保护线

1. POC4 `package.json` 不得包含 Electron、`node-pty`、`electron-vite` 或 `electron-log`。
2. POC4 前端源码中 `window.electronAPI` 引用必须为零。
3. 前端不得保存或显示 PVC、Pod、Job、ServiceAccount、Namespace 或集群内绝对路径。
4. 不批量复制 EnsoAI renderer；只有迁移清单内组件经过依赖审查后才能进入 POC4。
5. UI 禁用不能被当作安全边界；后端必须重复验证所有规则。
6. 日志和终端分别使用独立协议、连接和生命周期。
7. 迁移代码保留 MIT 声明和来源提交。
8. 包管理统一使用 pnpm，不使用 npm。
9. 所有新增文本文件使用 UTF-8 无 BOM，并遵守仓库换行策略。

## 15. 风险与证据缺口

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 隐藏的 Electron/本地路径耦合 | 越权、构建失败或错误生命周期 | 白名单迁移、零 Electron 检查、gateway 边界 |
| Monaco Worker 在 Web 构建不一致 | 编辑器空白或语言能力失效 | 阶段 0 使用 Vite Worker 构建并验证生产包 |
| xterm 高频流和销毁竞态 | 输出丢失、重复输入或旧会话存活 | 独立 transport、状态测试、服务端销毁确认 |
| 前端和后端状态漂移 | 运行中误解锁或终态后显示旧文件 | 权威 Run 状态、409 同步、强制重载阶段 |
| 日志补拉与实时订阅之间有缺口 | 刷新或断线丢日志 | 单调 `seq`、同一 WSS 内 replay 后 live |
| 浏览器端推断命令审计 | 审计数据错误 | 容器 Shell 集成或后端 PTY 包装层 |
| 复制过多 EnsoAI 功能 | 工期回升且范围失控 | YAGNI、必要组件清单、阶段退出门 |

当前最缺的关键证据是阶段 0 浏览器兼容性 Spike：尚未证明抽取后的主题、Tabs、Monaco Worker、xterm 和面板布局能在纯 Vite Web 工程中一起完成生产构建并稳定运行。

## 16. 最终判断

1. **值得做，但需要按本文修改做法。** 复用设计系统和细粒度组件，放弃整体移植 renderer。
2. **最大风险是隐藏的语义耦合。** 能编译不等于保留了正确的安全、路径和生命周期边界。
3. **最缺的关键证据是浏览器兼容性 Spike。** 静态分析不能代替真实构建、浏览器和销毁测试。
4. **今天可执行的最小一步是阶段 0。** 使用假文件数据和本地 WebSocket echo，验证主题、Tabs、Monaco、xterm、resize 和 dispose，不接业务后端。
5. **当前置信度为 84%。** 技术栈和细粒度组件兼容证据较强；节省比例、大文件性能、WebSocket 恢复和终端审计仍未运行验证。

## 17. 阶段 0 决策门

阶段 0 只有同时满足以下条件，才继续完整迁移：

- `pnpm build` 和类型检查通过。
- Chrome/Edge 中 Monaco 可编辑、切换模型且 Worker 正常。
- xterm 可输入、输出、resize、断开并 dispose，旧会话不再接收数据。
- 1280 px 宽度下布局无重叠和不可达操作。
- 生产构建中没有 Electron、Node 内置模块或本机绝对路径引用。
- 迁移组件清单、实际修改量和预估节省仍支持“选择性迁移优于重写”的结论。

任一核心条件失败时，先缩小迁移范围；如果 Monaco/xterm 或核心布局需要持续携带 EnsoAI 业务依赖，则改为只复用设计变量和 UI primitives，不继续迁移工作台组件。
