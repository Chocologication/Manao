# EnsoAI Stage 0 Browser Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可生产构建的纯浏览器 POC4 前端 Spike，验证从 EnsoAI 选择性迁移设计系统、编辑器标签、Monaco 和 xterm 的路线是否成立。

**Architecture:** Spike 只包含浏览器 renderer，不连接真实 POC4 后端。React 组件通过本地 mock 文件数据和独立 WebSocket echo server 验证交互；Monaco 使用 Vite ESM Worker，xterm 使用显式 transport 和销毁生命周期。任何 Electron、本机路径、Git、Worktree、Agent 或 Kubernetes 标识都由自动边界检查拒绝。

**Tech Stack:** pnpm 10、React 19、TypeScript 5.9、Vite 7、Tailwind CSS 4、Vitest、Testing Library、Playwright、Monaco Editor 0.55、xterm.js 6 beta、Lucide React、Framer Motion。

**Current Documentation:** Vite 7.3.1 的 Worker 与 TypeScript 构建规则来自 `vitejs/vite` 官方文档；Monaco Worker、model URI 和 dispose 规则来自 `microsoft/monaco-editor` 官方 ESM 集成文档；xterm 的 FitAddon、`onData`、`write`、`resize` 和 dispose 规则来自 `xtermjs/xterm.js` 官方文档。实施时如锁定版本发生变化，必须重新查询对应版本文档。

---

## 0. 执行边界

本计划只实施 `poc4/docs/2026-08-20-ensoai-frontend-reuse-design.md` 的阶段 0，不实现登录、项目 CRUD、真实文件 API、Run、日志、Kubernetes 或终端审计。

执行开始前：

1. 使用 `superpowers:using-git-worktrees` 创建隔离工作区。
2. 保留主工作区中的任何无关改动，所有提交只包含 `poc4/frontend`、阶段 0 证据和必要许可证文件。
3. 验证 EnsoAI 来源仍为 `D:\DeepLearning\MyProjects\Enso_AI` 的提交 `5aa294a`；如果提交变化，从该提交读取迁移源，不从新 HEAD 静默迁移。
4. 所有包操作使用 pnpm；禁止 npm。
5. 所有手工编辑使用小范围 `apply_patch`；写入 UTF-8 无 BOM。

命令工作目录约定：Task 1 Step 1 从仓库根目录运行；Task 1 Step 2 进入 `poc4/frontend` 后，Task 1 Step 3 至 Task 6 均保持该目录。期间的 Git 命令使用 `git -C ../..` 明确指向仓库根目录。Task 7 按步骤说明返回仓库根目录。

阶段 0 通过后再分别编写以下计划：

- 阶段 1：认证、路由和项目生命周期。
- 阶段 2--3：文件 API、文件树、显式保存和运行锁。
- 阶段 4：Run 状态机与持久化日志。
- 阶段 5：活动 Job 终端与审计展示。
- 阶段 6：重启恢复、真实集群和端到端验收。

## 1. 目标文件结构

```text
poc4/
├─ frontend/
│  ├─ package.json
│  ├─ pnpm-lock.yaml
│  ├─ index.html
│  ├─ vite.config.ts
│  ├─ vitest.config.ts
│  ├─ playwright.config.ts
│  ├─ tsconfig.json
│  ├─ tsconfig.app.json
│  ├─ tsconfig.node.json
│  ├─ THIRD_PARTY_NOTICES.md
│  ├─ scripts/
│  │  ├─ browser-boundary-lib.mjs
│  │  ├─ browser-boundary-lib.test.mjs
│  │  ├─ check-browser-boundary.mjs
│  │  └─ echo-ws.mjs
│  ├─ src/
│  │  ├─ main.tsx
│  │  ├─ App.tsx
│  │  ├─ test/setup.ts
│  │  ├─ styles/globals.css
│  │  ├─ lib/
│  │  │  ├─ utils.ts
│  │  │  ├─ motion.ts
│  │  │  ├─ monacoSetup.ts
│  │  │  ├─ monacoModels.ts
│  │  │  └─ monacoModels.test.ts
│  │  ├─ components/
│  │  │  ├─ ui/button.tsx
│  │  │  ├─ shell/WorkbenchSpike.tsx
│  │  │  ├─ shell/WorkbenchSpike.test.tsx
│  │  │  ├─ files/EditorTabs.tsx
│  │  │  ├─ files/EditorTabs.test.tsx
│  │  │  ├─ files/MonacoPanel.tsx
│  │  │  ├─ files/fileIcons.tsx
│  │  │  ├─ terminal/TerminalPanel.tsx
│  │  │  ├─ terminal/TerminalSearchBar.tsx
│  │  │  └─ terminal/ResizeHandle.tsx
│  │  ├─ features/editor/editorTypes.ts
│  │  ├─ terminal/
│  │  │  ├─ protocol.ts
│  │  │  ├─ protocol.test.ts
│  │  │  ├─ WebSocketTerminalTransport.ts
│  │  │  ├─ TerminalSession.ts
│  │  │  └─ TerminalSession.test.ts
│  │  └─ spike/mockFiles.ts
│  └─ tests/e2e/spike.spec.ts
└─ docs/evidence/stage-0/
   ├─ chrome-1280x720.png
   ├─ chrome-1440x900.png
   ├─ chrome-1920x1080.png
   ├─ edge-1280x720.png
   ├─ edge-1440x900.png
   ├─ edge-1920x1080.png
   └─ result.md
```

## Task 1: 建立纯浏览器工程骨架

**Files:**

- Create: `poc4/frontend/package.json`
- Create: `poc4/frontend/vite.config.ts`
- Create: `poc4/frontend/vitest.config.ts`
- Create: `poc4/frontend/tsconfig.json`
- Create: `poc4/frontend/tsconfig.app.json`
- Create: `poc4/frontend/tsconfig.node.json`
- Create: `poc4/frontend/index.html`
- Modify: `poc4/frontend/.gitignore`
- Create: `poc4/frontend/src/main.tsx`
- Create: `poc4/frontend/src/App.tsx`
- Create: `poc4/frontend/src/test/setup.ts`

- [ ] **Step 1: 验证阶段 0 目录尚未被其他实现占用**

Run:

```powershell
Get-ChildItem -Force poc4
Test-Path poc4\frontend
git status --short
```

Expected: `poc4/frontend` 不存在；如已存在，先读取其全部配置和状态，不覆盖未知文件。

- [ ] **Step 2: 使用 pnpm 创建 Vite 7 React TypeScript 骨架**

Run:

```powershell
Set-Location poc4
pnpm create vite@7.3.1 frontend --template react-ts
Set-Location frontend
```

Expected: 创建 `package.json`、TypeScript 配置、`src` 和 `index.html`，不生成 `package-lock.json`。

在 scaffold 生成的 `.gitignore` 末尾加入：

```gitignore
/test-results/
/playwright-report/
```

- [ ] **Step 3: 安装与 EnsoAI 对齐的浏览器依赖**

Run:

```powershell
pnpm add react@^19.1.4 react-dom@^19.1.4 @base-ui/react@^1.0.0 @monaco-editor/react@^4.7.0 monaco-editor@^0.55.1 @xterm/xterm@^6.1.0-beta.141 @xterm/addon-fit@^0.12.0-beta.141 @xterm/addon-search@^0.17.0-beta.141 @xterm/addon-webgl@^0.20.0-beta.140 class-variance-authority@^0.7.1 clsx@^2.1.1 framer-motion@^12.23.26 lucide-react@^0.562.0 tailwind-merge@^3.4.0
pnpm add -D typescript@^5.9.3 vite@^7.3.0 @vitejs/plugin-react@^5.1.2 tailwindcss@^4.1.18 @tailwindcss/vite@^4.1.18 vitest@^3.2.4 jsdom@^29.1.1 @testing-library/react@^16.3.2 @testing-library/dom@^10.4.1 @testing-library/jest-dom @testing-library/user-event @playwright/test ws @types/ws @types/node@^25.0.3 @types/react@^19.2.7 @types/react-dom@^19.2.3
```

Expected: 只生成或更新 `pnpm-lock.yaml`；所有 Electron 和 Node PTY 包均不存在。

- [ ] **Step 4: 配置生产构建、测试和路径别名**

将 `package.json` scripts 调整为：

```json
{
  "scripts": {
    "dev": "vite --port 4173",
    "dev:echo": "node scripts/echo-ws.mjs",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "test:boundary": "node --test scripts/browser-boundary-lib.test.mjs && node scripts/check-browser-boundary.mjs",
    "build": "pnpm typecheck && vite build",
    "preview": "vite preview --port 4173",
    "test:e2e": "playwright test --project=chromium",
    "test:e2e:channels": "playwright test --project=chrome --project=edge"
  }
}
```

同时设置：

```json
{
  "packageManager": "pnpm@10.33.0",
  "engines": {
    "node": ">=20"
  }
}
```

将 `vite.config.ts` 写为：

```ts
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
```

将 `vitest.config.ts` 写为：

```ts
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
```

将 `src/test/setup.ts` 写为：

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 5: 将默认页面替换为最小可构建入口**

`src/App.tsx`：

```tsx
export default function App() {
  return <main data-testid="stage-0-root">POC4 Stage 0</main>;
}
```

`src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

先创建最小 `src/styles/globals.css`：

```css
@import "tailwindcss";

html,
body,
#root {
  width: 100%;
  min-width: 1280px;
  height: 100%;
  margin: 0;
}
```

- [ ] **Step 6: 运行首次验证**

Run:

```powershell
pnpm typecheck
pnpm test -- --passWithNoTests
pnpm build
```

Expected: 三条命令退出码均为 0；`dist` 生成；无 Electron 相关模块解析错误。

- [ ] **Step 7: 提交工程骨架**

```powershell
git -C ../.. add poc4/frontend
git -C ../.. commit -m "chore(poc4): scaffold browser-only frontend spike"
```

只暂存 `poc4/frontend`，不暂存无关文件。

## Task 2: 建立浏览器边界守卫和迁移许可证

**Files:**

- Create: `poc4/frontend/scripts/browser-boundary-lib.mjs`
- Create: `poc4/frontend/scripts/browser-boundary-lib.test.mjs`
- Create: `poc4/frontend/scripts/check-browser-boundary.mjs`
- Create: `poc4/frontend/THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: 先写边界检测失败测试**

`scripts/browser-boundary-lib.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { findForbiddenDependencies, findForbiddenSource } from './browser-boundary-lib.mjs';

test('rejects Electron and PTY production dependencies', () => {
  assert.deepEqual(
    findForbiddenDependencies({ dependencies: { electron: '1', 'node-pty': '1' } }),
    ['electron', 'node-pty']
  );
});

test('rejects Electron APIs and machine-specific absolute paths', () => {
  const source = [
    'window.electronAPI.file.read(path)',
    "import { ipcRenderer } from 'electron'",
    "const root = 'D:\\\\DeepLearning\\\\repo'",
    "const macRoot = '/Users/example/repo'",
  ].join('\n');

  assert.deepEqual(findForbiddenSource('fixture.ts', source).map((item) => item.rule), [
    'electron-api',
    'electron-import',
    'windows-absolute-path',
    'macos-absolute-path',
  ]);
});

test('allows browser WebSocket and project-relative paths', () => {
  const source = "new WebSocket(url); const path = 'src/main/App.java';";
  assert.deepEqual(findForbiddenSource('fixture.ts', source), []);
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run:

```powershell
node --test scripts/browser-boundary-lib.test.mjs
```

Expected: FAIL，原因是 `browser-boundary-lib.mjs` 或导出函数尚不存在。

- [ ] **Step 3: 实现最小边界检测库**

`scripts/browser-boundary-lib.mjs`：

```js
const forbiddenDependencies = ['electron', 'electron-vite', 'electron-log', 'node-pty'];

const sourceRules = [
  ['electron-api', /window\.electronAPI/],
  ['electron-import', /(?:from\s+|import\s*)['"]electron(?:\/[^'"]*)?['"]/],
  ['node-pty', /['"]node-pty['"]/],
  ['windows-absolute-path', /[A-Za-z]:\\(?:Users|DeepLearning|Projects)\\/],
  ['macos-absolute-path', /['"]\/Users\//],
];

export function findForbiddenDependencies(packageJson) {
  const production = Object.keys(packageJson.dependencies ?? {});
  return forbiddenDependencies.filter((name) => production.includes(name));
}

export function findForbiddenSource(file, source) {
  return sourceRules
    .filter(([, pattern]) => pattern.test(source))
    .map(([rule]) => ({ file, rule }));
}
```

- [ ] **Step 4: 运行单元测试并确认通过**

Run:

```powershell
node --test scripts/browser-boundary-lib.test.mjs
```

Expected: 3 tests PASS。

- [ ] **Step 5: 实现项目扫描入口**

`scripts/check-browser-boundary.mjs` 必须：

1. 读取 `package.json` 并调用 `findForbiddenDependencies`。
2. 递归扫描 `src` 内 `.ts`、`.tsx`、`.js`、`.jsx`、`.css`。
3. 调用 `findForbiddenSource`，按 `file: rule` 输出违规项。
4. 有违规时退出 1；没有违规时输出 `Browser boundary check passed.` 并退出 0。

核心实现：

```js
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbiddenDependencies, findForbiddenSource } from './browser-boundary-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return extensions.has(path.extname(entry.name)) ? [fullPath] : [];
  }));
  return nested.flat();
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dependencyViolations = findForbiddenDependencies(packageJson).map(
  (name) => ({ file: 'package.json', rule: `forbidden dependency: ${name}` })
);
const sourceFiles = await listSourceFiles(path.join(root, 'src'));
const sourceViolations = (
  await Promise.all(sourceFiles.map(async (file) =>
    findForbiddenSource(path.relative(root, file), await readFile(file, 'utf8'))
  ))
).flat();
const violations = [...dependencyViolations, ...sourceViolations];

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.file}: ${violation.rule}`);
  process.exitCode = 1;
} else {
  console.log('Browser boundary check passed.');
}
```

- [ ] **Step 6: 写入第三方声明**

`THIRD_PARTY_NOTICES.md` 必须包含：

```markdown
# Third-Party Notices

## EnsoAI

Selected visual styles and browser-compatible UI interactions were adapted from EnsoAI commit `5aa294a`.

MIT License

Copyright (c) 2025 EnsoAI Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 7: 运行边界验证并提交**

Run:

```powershell
pnpm test:boundary
git -C ../.. diff --check
git -C ../.. add poc4/frontend/scripts poc4/frontend/THIRD_PARTY_NOTICES.md poc4/frontend/package.json
git -C ../.. commit -m "test(poc4): guard browser-only frontend boundary"
```

Expected: 3 tests PASS；输出 `Browser boundary check passed.`；提交不包含其他目录。

## Task 3: 迁移 EnsoAI 视觉系统并组装工作台 Shell

**Files:**

- Create: `poc4/frontend/src/lib/utils.ts`
- Create: `poc4/frontend/src/lib/motion.ts`
- Create: `poc4/frontend/src/components/ui/button.tsx`
- Create: `poc4/frontend/src/components/shell/WorkbenchSpike.tsx`
- Create: `poc4/frontend/src/components/shell/WorkbenchSpike.test.tsx`
- Modify: `poc4/frontend/src/styles/globals.css`
- Modify: `poc4/frontend/src/App.tsx`
- Source references: `D:\DeepLearning\MyProjects\Enso_AI\src\renderer\styles\globals.css`, `lib/utils.ts`, `lib/motion.ts`, `components/ui/button.tsx`

- [ ] **Step 1: 先写工作台 Shell 失败测试**

`src/components/shell/WorkbenchSpike.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { WorkbenchSpike } from './WorkbenchSpike';

describe('WorkbenchSpike', () => {
  it('keeps only the POC4 panels and switches the active panel', async () => {
    const user = userEvent.setup();
    render(<WorkbenchSpike />);

    expect(screen.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /Agent|VSC|Git|Worktree/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('run-spike-panel')).toBeVisible();
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
pnpm test -- src/components/shell/WorkbenchSpike.test.tsx
```

Expected: FAIL，`WorkbenchSpike` 尚不存在。

- [ ] **Step 3: 迁移浏览器安全的设计基础**

从 EnsoAI 对应文件迁移以下内容：

- `utils.ts` 的 `cn` 实现。
- `motion.ts` 的 `springFast`、`springStandard`、`fadeVariants`。
- `button.tsx` 的 `Button` 和 variant 定义，删除任何未使用 variant。
- `globals.css` 的 `@theme`、light/dark CSS 变量、字体、边框、滚动条和 xterm 尺寸样式。

`globals.css` 必须删除或不迁移：

- `.drag-region`、`.no-drag` 和 `-webkit-app-region`。
- 背景图片透明度逻辑。
- 全局 `user-select: none`。
- 清除所有 focus/focus-visible outline 的规则。
- Git diff highlight。

保留可见键盘焦点：

```css
@layer base {
  * {
    @apply border-border;
  }

  body {
    @apply bg-background text-foreground;
    font-family: var(--font-family-sans, "Inter", system-ui, sans-serif);
  }

  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
}
```

- [ ] **Step 4: 实现最小 EnsoAI 风格工作台 Shell**

`WorkbenchSpike.tsx` 使用本地状态 `activePanel: 'file' | 'run' | 'terminal'`，并满足：

- 左侧 256 px 文件树 mock 区域。
- 顶部 48 px 的 File、Run、Terminal tabs。
- 中央面板使用 `min-width: 0`、`min-height: 0`，不会被内容撑破。
- Run 和 Terminal 先放明确的 `data-testid` 容器，后续任务替换内部内容。
- 不出现 Agent、Git、VSC、Worktree 或桌面窗口按钮。

Tab 核心结构：

```tsx
const panels = [
  { id: 'file', label: 'File', icon: FileCode },
  { id: 'run', label: 'Run', icon: Play },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
] as const;

<div role="tablist" aria-label="Workbench panels" className="flex items-center gap-1">
  {panels.map((panel) => (
    <button
      key={panel.id}
      type="button"
      role="tab"
      aria-selected={activePanel === panel.id}
      onClick={() => setActivePanel(panel.id)}
      className={cn(
        'relative flex h-8 items-center gap-1.5 rounded-md px-3 text-sm',
        activePanel === panel.id
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <panel.icon className="h-4 w-4" />
      {panel.label}
    </button>
  ))}
</div>
```

- [ ] **Step 5: 让 App 渲染工作台并运行测试**

`src/App.tsx`：

```tsx
import { WorkbenchSpike } from '@/components/shell/WorkbenchSpike';

export default function App() {
  return <WorkbenchSpike />;
}
```

Run:

```powershell
pnpm test -- src/components/shell/WorkbenchSpike.test.tsx
pnpm typecheck
pnpm test:boundary
```

Expected: 测试 PASS；类型检查和边界检查退出 0。

- [ ] **Step 6: 提交视觉 Shell**

```powershell
git -C ../.. add poc4/frontend/src
git -C ../.. commit -m "feat(poc4): migrate browser-safe EnsoAI workbench shell"
```

## Task 4: 迁移编辑器 Tabs 并验证 Monaco Worker 和模型生命周期

**Files:**

- Create: `poc4/frontend/src/features/editor/editorTypes.ts`
- Create: `poc4/frontend/src/components/files/fileIcons.tsx`
- Create: `poc4/frontend/src/components/files/EditorTabs.tsx`
- Create: `poc4/frontend/src/components/files/EditorTabs.test.tsx`
- Create: `poc4/frontend/src/lib/monacoSetup.ts`
- Create: `poc4/frontend/src/lib/monacoModels.ts`
- Create: `poc4/frontend/src/lib/monacoModels.test.ts`
- Create: `poc4/frontend/src/components/files/MonacoPanel.tsx`
- Create: `poc4/frontend/src/spike/mockFiles.ts`
- Modify: `poc4/frontend/src/components/shell/WorkbenchSpike.tsx`
- Source references: EnsoAI `components/files/EditorTabs.tsx`, `fileIcons.tsx`, `monacoSetup.ts`

- [ ] **Step 1: 先写相对模型 URI 失败测试**

`src/lib/monacoModels.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { toModelUri } from './monacoModels';

describe('toModelUri', () => {
  it('creates stable project-relative Monaco URIs', () => {
    expect(toModelUri('pom.xml').toString()).toBe('poc4://workspace/pom.xml');
    expect(toModelUri('src/main/App.java').toString()).toBe(
      'poc4://workspace/src/main/App.java'
    );
  });

  it.each(['', '/etc/passwd', '../secret', 'src/../../secret', 'C:\\repo\\file'])(
    'rejects invalid model path %s',
    (path) => expect(() => toModelUri(path)).toThrow('Project-relative path required')
  );
});
```

- [ ] **Step 2: 运行模型 URI 测试并确认失败**

Run:

```powershell
pnpm test -- src/lib/monacoModels.test.ts
```

Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 实现相对路径模型 URI**

`src/lib/monacoModels.ts`：

```ts
import * as monaco from 'monaco-editor';

const windowsDrive = /^[A-Za-z]:[\\/]/;

export function toModelUri(path: string): monaco.Uri {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    windowsDrive.test(path) ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Project-relative path required');
  }
  return monaco.Uri.from({ scheme: 'poc4', authority: 'workspace', path: `/${normalized}` });
}

export function disposeModel(path: string): void {
  monaco.editor.getModel(toModelUri(path))?.dispose();
}

export function disposeAllPoc4Models(): void {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'poc4') model.dispose();
  }
}
```

- [ ] **Step 4: 配置 Vite Monaco Workers**

`src/lib/monacoSetup.ts`：

```ts
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};
```

这一步使用 Vite `?worker` 构造器，不迁移 Electron Worker URL 或 CDN 配置。

- [ ] **Step 5: 写 EditorTabs 失败测试**

`src/components/files/EditorTabs.test.tsx` 至少覆盖 dirty、切换和关闭：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorTabs } from './EditorTabs';

const tabs = [
  { path: 'pom.xml', title: 'pom.xml', isDirty: true },
  { path: 'src/main/App.java', title: 'App.java', isDirty: false },
];

describe('EditorTabs', () => {
  it('shows dirty state and emits relative paths', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <EditorTabs
        tabs={tabs}
        activePath="pom.xml"
        onSelect={onSelect}
        onClose={onClose}
        onReorder={() => {}}
      />
    );

    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    await user.click(screen.getByRole('tab', { name: /App.java/ }));
    expect(onSelect).toHaveBeenCalledWith('src/main/App.java');
    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(onClose).toHaveBeenCalledWith('pom.xml');
  });
});
```

- [ ] **Step 6: 迁移并裁剪 EditorTabs 和文件图标**

从 EnsoAI `EditorTabs.tsx` 保留：

- 36 px 高度、120--180 px 宽度、active indicator、dirty 标记、文件图标。
- 拖动排序、点击切换、关闭按钮、活动项自动滚入视图。

删除：

- `useI18n`、Toast、Context Menu 和 `Send to session`。
- EnsoAI store 类型。

`editorTypes.ts`：

```ts
export type EditorTab = {
  path: string;
  title: string;
  isDirty: boolean;
};
```

所有交互以 `role="tablist"`、`role="tab"`、`aria-selected` 和关闭按钮 `aria-label` 暴露给键盘和测试。

- [ ] **Step 7: 实现 MonacoPanel 的最小多模型行为**

`mockFiles.ts` 提供三个相对路径文件：`pom.xml`、`src/main/java/demo/App.java`、`src/test/java/demo/AppTest.java`。

`MonacoPanel.tsx` 必须：

- 导入 `@/lib/monacoSetup`。
- 以 `path={toModelUri(active.path).toString()}` 向 `@monaco-editor/react` 提供稳定模型 URI。
- 用户编辑时只更新本地 mock 内容和 dirty 状态。
- 切换标签后保留各自内容。
- 关闭标签时调用 `disposeModel(path)`。
- 组件整体卸载时调用 `disposeAllPoc4Models()`。
- 设置 `automaticLayout: true`、`scrollBeyondLastLine: false`，不接自动保存、Agent 或 Git。

核心 Editor：

```tsx
<Editor
  height="100%"
  path={toModelUri(activeFile.path).toString()}
  value={activeFile.content}
  language={activeFile.language}
  theme="vs-dark"
  onChange={(value) => updateContent(activeFile.path, value ?? '')}
  options={{ automaticLayout: true, scrollBeyondLastLine: false }}
/>
```

- [ ] **Step 8: 运行编辑器测试、构建和边界检查**

Run:

```powershell
pnpm test -- src/lib/monacoModels.test.ts src/components/files/EditorTabs.test.tsx
pnpm typecheck
pnpm build
pnpm test:boundary
```

Expected: 所有测试 PASS；生产构建生成独立 Monaco Worker assets；边界检查通过。

- [ ] **Step 9: 提交编辑器 Spike**

```powershell
git -C ../.. add poc4/frontend/src
git -C ../.. commit -m "feat(poc4): validate browser Monaco and editor tabs"
```

## Task 5: 实现浏览器 xterm transport、echo server 和销毁生命周期

**Files:**

- Create: `poc4/frontend/src/terminal/protocol.ts`
- Create: `poc4/frontend/src/terminal/protocol.test.ts`
- Create: `poc4/frontend/src/terminal/WebSocketTerminalTransport.ts`
- Create: `poc4/frontend/src/terminal/TerminalSession.ts`
- Create: `poc4/frontend/src/terminal/TerminalSession.test.ts`
- Create: `poc4/frontend/src/components/terminal/TerminalPanel.tsx`
- Create: `poc4/frontend/src/components/terminal/TerminalSearchBar.tsx`
- Create: `poc4/frontend/src/components/terminal/ResizeHandle.tsx`
- Create: `poc4/frontend/scripts/echo-ws.mjs`
- Modify: `poc4/frontend/src/components/shell/WorkbenchSpike.tsx`
- Source references: EnsoAI `TerminalSearchBar.tsx`, `ResizeHandle.tsx`, and the xterm-only behavior in `useXterm.ts`

- [ ] **Step 1: 先写终端协议失败测试**

`src/terminal/protocol.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { decodeServerControl, encodeClientControl, encodeTerminalInput } from './protocol';

describe('terminal protocol', () => {
  it('encodes input as binary and control as JSON text', () => {
    expect(encodeTerminalInput('mvn test')).toBeInstanceOf(Uint8Array);
    expect(encodeClientControl({ type: 'terminal.resize', cols: 120, rows: 32 })).toBe(
      '{"type":"terminal.resize","cols":120,"rows":32}'
    );
  });

  it('accepts only known server controls', () => {
    expect(decodeServerControl('{"type":"terminal.ready","sessionId":"spike-1"}')).toEqual({
      type: 'terminal.ready',
      sessionId: 'spike-1',
    });
    expect(() => decodeServerControl('{"type":"unknown"}')).toThrow('Unknown terminal control');
  });
});
```

- [ ] **Step 2: 运行协议测试并确认失败**

Run:

```powershell
pnpm test -- src/terminal/protocol.test.ts
```

Expected: FAIL，协议模块尚不存在。

- [ ] **Step 3: 实现二进制数据和文本控制协议**

`protocol.ts` 定义并导出：

```ts
export type TerminalClientControl =
  | { type: 'terminal.resize'; cols: number; rows: number }
  | { type: 'terminal.close' };

export type TerminalServerControl =
  | { type: 'terminal.ready'; sessionId: string }
  | { type: 'terminal.exit'; exitCode: number | null }
  | { type: 'terminal.error'; code: string };

const encoder = new TextEncoder();

export const encodeTerminalInput = (data: string): Uint8Array => encoder.encode(data);
export const encodeClientControl = (control: TerminalClientControl): string =>
  JSON.stringify(control);

export function decodeServerControl(data: string): TerminalServerControl {
  const value = JSON.parse(data) as Record<string, unknown>;
  if (value.type === 'terminal.ready' && typeof value.sessionId === 'string') {
    return { type: 'terminal.ready', sessionId: value.sessionId };
  }
  if (value.type === 'terminal.exit' && (typeof value.exitCode === 'number' || value.exitCode === null)) {
    return { type: 'terminal.exit', exitCode: value.exitCode };
  }
  if (value.type === 'terminal.error' && typeof value.code === 'string') {
    return { type: 'terminal.error', code: value.code };
  }
  throw new Error('Unknown terminal control');
}
```

- [ ] **Step 4: 先写 TerminalSession 销毁失败测试**

`TerminalSession.test.ts` 先定义与正式接口一致的 fake。`onOutput` 返回取消订阅函数，便于证明 dispose 后不会处理迟到输出：

```ts
import { describe, expect, it, vi } from 'vitest';
import { TerminalSession, type TerminalAdapter, type TerminalTransport } from './TerminalSession';

function createFakeTerminal(): TerminalAdapter {
  return {
    open: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    getSize: () => ({ cols: 80, rows: 24 }),
  };
}

function createFakeTransport(): TerminalTransport & { emitOutput(data: Uint8Array): void } {
  let outputListener: ((data: Uint8Array) => void) | null = null;
  return {
    connect: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onOutput: vi.fn((listener) => {
      outputListener = listener;
      return () => { outputListener = null; };
    }),
    emitOutput: (data) => outputListener?.(data),
  };
}

it('closes transport and disposes terminal exactly once', () => {
  const terminal = createFakeTerminal();
  const transport = createFakeTransport();
  const session = new TerminalSession(terminal, transport);

  session.open(document.createElement('div'));
  session.dispose();
  session.dispose();

  expect(transport.close).toHaveBeenCalledTimes(1);
  expect(terminal.dispose).toHaveBeenCalledTimes(1);
});

it('does not forward output after disposal', () => {
  const terminal = createFakeTerminal();
  const transport = createFakeTransport();
  const session = new TerminalSession(terminal, transport);
  session.open(document.createElement('div'));
  session.dispose();
  transport.emitOutput(new Uint8Array([65]));
  expect(terminal.write).not.toHaveBeenCalled();
});

it('forwards resize only while active', () => {
  const terminal = createFakeTerminal();
  const transport = createFakeTransport();
  const session = new TerminalSession(terminal, transport);
  session.open(document.createElement('div'));
  session.resize(120, 32);
  session.dispose();
  session.resize(140, 40);
  expect(transport.resize).toHaveBeenCalledTimes(1);
  expect(transport.resize).toHaveBeenCalledWith(120, 32);
});
```

- [ ] **Step 5: 实现 transport 和幂等 TerminalSession**

`WebSocketTerminalTransport` 负责：

- 创建 `WebSocket`，设置 `binaryType = 'arraybuffer'`。
- binary message 触发 output listeners。
- text message 通过 `decodeServerControl` 触发 control listeners。
- 输入以 `Uint8Array` 发送；resize/close 以 JSON text 发送。
- `close()` 幂等，清理所有 listener，并关闭 socket。

`TerminalSession` 负责：

- `terminal.open(container)`，加载 `FitAddon` 和 `SearchAddon`。
- `terminal.onData` 只调用 transport 的 `sendInput`。
- transport output 只调用 `terminal.write`。
- `resize(cols, rows)` 只在活动会话中转发给 transport。
- `dispose()` 依次清理订阅、observer、transport、addon 和 terminal，且只能执行一次。
- dispose 后忽略所有迟到事件，不复用 terminal 实例。

正式接口固定为：

```ts
export type Disposable = { dispose(): void };

export interface TerminalAdapter {
  open(container: HTMLElement): void;
  write(data: Uint8Array | string): void;
  onData(listener: (data: string) => void): Disposable;
  getSize(): { cols: number; rows: number };
  dispose(): void;
}

export interface TerminalTransport {
  connect(): void;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(listener: (data: Uint8Array) => void): () => void;
  close(): void;
}
```

`TerminalPanel` 创建实际 xterm adapter，负责加载 Fit/Search/WebGL addons 和 ResizeObserver；`TerminalSession` 只协调 adapter 与 transport，从而使销毁规则可在 jsdom 中测试。

- [ ] **Step 6: 实现本地 WebSocket echo server**

`scripts/echo-ws.mjs` 使用同一 HTTP server 提供 `/health` 和 `/terminal` WebSocket：

```js
import http from 'node:http';
import { WebSocketServer } from 'ws';

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/terminal') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client));
});

wss.on('connection', (client) => {
  client.send(JSON.stringify({ type: 'terminal.ready', sessionId: crypto.randomUUID() }));
  client.send(new TextEncoder().encode('\u001b[32mPOC4 browser terminal ready\u001b[0m\r\n'));
  client.on('message', (data, isBinary) => {
    if (isBinary) client.send(data, { binary: true });
    else if (JSON.parse(data.toString()).type === 'terminal.close') client.close(1000);
  });
});

server.listen(4174, '127.0.0.1');

function shutdown() {
  for (const client of wss.clients) client.terminate();
  wss.close(() => server.close(() => process.exit(0)));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
```

- [ ] **Step 7: 迁移纯 UI 终端组件并接入 transport**

- `TerminalSearchBar.tsx` 从 EnsoAI 迁移，保留搜索、大小写、整词、正则和关闭。
- `ResizeHandle.tsx` 从 EnsoAI 迁移，但使用父容器宽度计算比例，不使用 `window.innerWidth`。
- `TerminalPanel.tsx` 提供 Connect、Disconnect 和连接状态；连接时创建全新 `TerminalSession`，断开时 dispose 并清空引用。
- ResizeObserver 中先执行 `fitAddon.fit()`，再调用 `session.resize(terminal.cols, terminal.rows)`。
- WebGL addon 加载失败时捕获异常并继续使用默认 renderer。
- 使用 `role="status"` 显示 `connecting/connected/disconnected/error`，供用户和 E2E 判断。
- 用 `data-testid="terminal-last-output"` 的 `sr-only` 区域保存最近解码输出，E2E 通过它验证 echo；生产阶段删除该 Spike 探针。

- [ ] **Step 8: 运行终端测试和生产构建**

Run:

```powershell
pnpm test -- src/terminal/protocol.test.ts src/terminal/TerminalSession.test.ts
pnpm typecheck
pnpm build
pnpm test:boundary
```

Expected: 协议与生命周期测试 PASS；构建通过；边界检查无 Electron、PTY 或绝对路径。

- [ ] **Step 9: 提交终端 Spike**

```powershell
git -C ../.. add poc4/frontend/src poc4/frontend/scripts/echo-ws.mjs poc4/frontend/package.json poc4/frontend/pnpm-lock.yaml
git -C ../.. commit -m "feat(poc4): validate browser xterm lifecycle"
```

## Task 6: 建立 Chrome/Edge 生产构建 E2E 和视觉证据

**Files:**

- Create: `poc4/frontend/playwright.config.ts`
- Create: `poc4/frontend/tests/e2e/spike.spec.ts`
- Create: six PNG files under `poc4/docs/evidence/stage-0/`

- [ ] **Step 1: 配置生产预览和 echo server**

`playwright.config.ts`：

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm build && pnpm preview --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev:echo',
      url: 'http://127.0.0.1:4174/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'edge', use: { channel: 'msedge' } },
  ],
});
```

- [ ] **Step 2: 写完整工作流 E2E**

`tests/e2e/spike.spec.ts` 覆盖：

1. 页面只有 File、Run、Terminal 三个主 tab。
2. Monaco 出现且无 Worker console error。
3. 编辑 `pom.xml`、切换到 Java 文件、再切回后内容仍存在且 dirty 标记仍在。
4. Terminal 连接后收到 `POC4 browser terminal ready`。
5. 键盘输入经 WebSocket echo 返回。
6. Disconnect 后状态变为 disconnected。
7. 再次 Connect 创建新 session；一次输入只回显一次，证明旧 listener 未残留。
8. 页面没有横向溢出，主区域和侧栏 bounding box 不重叠。

核心断言：

```ts
const consoleErrors: string[] = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.goto('/');
await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
await expect(page.locator('.monaco-editor')).toBeVisible();

await page.getByRole('tab', { name: 'Terminal' }).click();
await page.getByRole('button', { name: 'Connect terminal' }).click();
await expect(page.getByRole('status')).toHaveText('connected');
await expect(page.getByTestId('terminal-last-output')).toContainText('POC4 browser terminal ready');

expect(consoleErrors).toEqual([]);
```

为真实 xterm input、模型切换和重连补全实际 locator，不用固定等待时间；统一使用可观察状态和 `expect` 自动等待。

- [ ] **Step 3: 添加三种 viewport 的截图测试**

只在 `chrome` 和 `edge` project 中生成：

```ts
const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

for (const viewport of viewports) {
  test(`captures ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('.monaco-editor')).toBeVisible();
    await page.screenshot({
      path: `../docs/evidence/stage-0/${testInfo.project.name}-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
```

- [ ] **Step 4: 安装 Playwright Chromium 并核对本机浏览器**

Run:

```powershell
pnpm exec playwright install chromium
Get-Command chrome.exe -ErrorAction SilentlyContinue
Get-Command msedge.exe -ErrorAction SilentlyContinue
```

如果 PATH 中找不到 Chrome/Edge，让 Playwright channel 自行按标准安装路径解析；只有 channel 测试实际启动成功才算证据。

- [ ] **Step 5: 运行 Chromium 快速 E2E**

Run:

```powershell
pnpm test:e2e
```

Expected: Chromium 工作流全部 PASS；生产构建由 Playwright webServer 重新执行。

- [ ] **Step 6: 运行真实 Chrome 和 Edge E2E**

Run:

```powershell
pnpm test:e2e:channels
```

Expected: Chrome 和 Edge 的工作流及截图测试全部 PASS；生成六张 PNG。

- [ ] **Step 7: 逐张检查视觉输出**

使用本地图片查看工具依次打开六张 PNG，检查：

- 左侧文件树、顶部 tabs、编辑器均非空。
- 1280 px 时无重叠、截断按钮或横向滚动。
- 1440/1920 px 时面板没有不合理拉伸。
- Monaco 画布不是纯色空白。
- 文本和图标没有越界。

发现任一问题时先修改布局并重新执行 Step 5--7，不把失败截图作为通过证据。

- [ ] **Step 8: 提交 E2E 和截图证据**

```powershell
git -C ../.. add poc4/frontend/playwright.config.ts poc4/frontend/tests poc4/docs/evidence/stage-0/*.png
git -C ../.. commit -m "test(poc4): verify EnsoAI spike in Chrome and Edge"
```

## Task 7: 完成阶段 0 验证报告和决策门

**Files:**

- Create: `poc4/docs/evidence/stage-0/result.md`
- Verify: all files under `poc4/frontend`

- [ ] **Step 1: 运行完整自动验证**

Run from `poc4/frontend`:

```powershell
pnpm test:boundary
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm test:e2e:channels
```

Expected: 每条命令退出码 0。不要用之前任务的输出代替本步骤的新鲜验证。

- [ ] **Step 2: 运行仓库级差异和编码检查**

Run from repository root:

```powershell
git diff --check
git status --short
$files = Get-ChildItem poc4\frontend,poc4\docs\evidence\stage-0 -Recurse -File |
  Where-Object { $_.Extension -in '.ts','.tsx','.js','.mjs','.json','.css','.md','.html','.yaml','.yml' }
foreach ($file in $files) {
  $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "UTF-8 BOM found: $($file.FullName)"
  }
}
```

Expected: `git diff --check` 无输出；没有 BOM 异常；`git status` 只显示阶段 0 预期文件或用户原有无关改动。

- [ ] **Step 3: 运行显式禁止项检查**

Run:

```powershell
$matches = rg -n -e 'window\.electronAPI' -e 'from .*electron' -e 'node-pty' -e 'electron-vite' -e 'electron-log' -e '[A-Za-z]:\\(Users|DeepLearning|Projects)\\' -e '/Users/' poc4/frontend/src poc4/frontend/package.json
if ($LASTEXITCODE -eq 0) { $matches; throw 'Forbidden browser dependency found' }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit code $LASTEXITCODE" }
```

Expected: 无匹配，`rg` 原始退出码为 1，PowerShell 脚本正常结束。

- [ ] **Step 4: 使用本轮真实输出编写验证报告**

先获取不可猜测的报告元数据：

```powershell
git rev-parse --short HEAD
Get-Date -Format yyyy-MM-dd
git diff --numstat fbfddb2..HEAD -- poc4/frontend
```

然后用 `apply_patch` 创建 `result.md`。文档必须包含以下章节，并直接写入 Steps 1--3 刚刚观察到的提交号、日期、退出码、测试数、构建时间、worker assets、浏览器用例数和扫描结果：

```markdown
# EnsoAI Stage 0 Browser Spike Result

## Source
## Automated Verification
## Visual Verification
## Boundary Verification
## Observed Migration Cost
## Decision
## Confidence
```

`Automated Verification` 使用表格逐行记录六条验证命令。`Decision` 只能是 `CONTINUE_SELECTIVE_MIGRATION`、`REDUCE_TO_DESIGN_SYSTEM_ONLY` 或 `ABANDON_REUSE` 之一，并在同一节列出支持证据。不得先写结论再补证据，也不得保留未完成标记。

- [ ] **Step 5: 对照阶段 0 决策门做逐项判定**

只有以下条件全部为真，报告才能选择 `CONTINUE_SELECTIVE_MIGRATION`：

1. `pnpm build` 和 typecheck 通过。
2. Chrome/Edge 中 Monaco Worker、模型切换和 dirty 状态正常。
3. xterm 输入、输出、resize、disconnect、dispose 和新会话正常。
4. 1280 px 无重叠和不可达操作。
5. 生产依赖和源码没有 Electron、Node PTY 或本机绝对路径。
6. 实际迁移仍比仅复用设计变量有明显收益。

任一技术条件失败，选择 `REDUCE_TO_DESIGN_SYSTEM_ONLY` 并写明失败项；只有设计系统本身也无法低成本迁移时选择 `ABANDON_REUSE`。

- [ ] **Step 6: 提交验证报告**

```powershell
$unfinished = @('TO' + 'DO', 'TB' + 'D', 'FIX' + 'ME')
foreach ($marker in $unfinished) {
  $matches = rg -n --fixed-strings $marker poc4/docs/evidence/stage-0/result.md
  if ($LASTEXITCODE -eq 0) { $matches; throw "Unfinished marker found: $marker" }
  if ($LASTEXITCODE -ne 1) { throw "rg failed with exit code $LASTEXITCODE" }
}
git diff --check
git add poc4/docs/evidence/stage-0/result.md
git commit -m "docs(poc4): record EnsoAI stage 0 spike decision"
```

Expected: `rg` 无匹配；提交只包含验证报告。

- [ ] **Step 7: 停在决策门，不自动进入阶段 1**

向用户报告：

- 阶段 0 的真实验证命令和结果。
- 六张截图位置。
- 实际决策和更新后的置信度。
- 未解决问题。
- 是否建议编写阶段 1 计划。

即使决策为继续，也必须等待用户确认后再编写阶段 1 计划。
