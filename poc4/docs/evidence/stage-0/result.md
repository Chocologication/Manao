# EnsoAI Stage 0 Browser Spike Result

## Source

- 日期：`2026-08-20`
- 分支：`poc4/ensoai-stage-0-spike`
- 本轮验证树：`399f778`（`git rev-parse --short HEAD`，含 Vitest 最小排除提交）
- EnsoAI 来源：`D:\DeepLearning\MyProjects\Enso_AI` 提交 `5aa294a`
- 许可证记录：`poc4/frontend/THIRD_PARTY_NOTICES.md`（MIT，来源提交 `5aa294a`）
- 行数统计：`git diff --numstat fbfddb2..HEAD -- poc4/frontend` → 51 个文件，+6131 / -0。其中 `pnpm-lock.yaml` +3586；其余前端源与配置 +2545。

本报告所有退出码、测试数、构建时间、worker 资源和扫描结果均来自该提交上的新鲜运行，不复用先前任务日志。

## Automated Verification

工作目录：`poc4/frontend`。六条命令均退出 0。

| 命令 | 退出码 | 墙钟 | 观察结果 |
|---|---:|---:|---|
| `pnpm test:boundary` | 0 | 1257 ms | node:test 3 pass / 0 fail（`duration_ms 109.1474`）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | 2368 ms | `tsc -b --pretty false` 无诊断输出 |
| `pnpm test` | 0 | 16313 ms | Vitest 3.2.7：Test Files 7 passed (7)；Tests 16 passed (16)；Duration 14.85s。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示，不计入失败 |
| `pnpm build` | 0 | 45012 ms | 内含 typecheck；Vite 7.3.6 production client；`3363 modules transformed`；`built in 41.14s`。存在 >500 kB chunk 提示，构建仍成功 |
| `pnpm test:e2e` | 0 | 52625 ms | Playwright Chromium：Running 4 tests using 1 worker；1 passed（spike workbench workflow 2.0s）；3 skipped（截图仅 chrome/edge）；合计 51.6s |
| `pnpm test:e2e:channels` | 0 | 56875 ms | Playwright chrome + edge：Running 8 tests using 2 workers；8 passed（两浏览器工作流 + 六张 viewport 截图）；合计 55.9s |

Vitest 在 `399f778` 之前会把 `scripts/browser-boundary-lib.test.mjs`（node:test）和 `tests/e2e/spike.spec.ts`（Playwright）收进 `vitest run`，导致 `pnpm test` 退出 1。该提交将 `test.exclude` 扩展为 `[...configDefaults.exclude, 'scripts/**', 'tests/e2e/**']`，不削弱 `src/**` 下 16 个真实单测。上表 `pnpm test` 是排除之后的新鲜运行。

生产构建独立 Monaco Worker（本次 `dist/assets`）：

| Asset | 体积 |
|---|---:|
| `editor.worker-C2_AfrSl.js` | 251.74 kB（251735 B） |
| `json.worker-C838mOW9.js` | 383.01 kB（383014 B） |
| `html.worker-eZJr__P7.js` | 693.12 kB（693120 B） |
| `css.worker-NZNbQL3P.js` | 1030.32 kB（1030315 B） |
| `ts.worker-BfwyojP3.js` | 7010.07 kB（7010073 B） |

无 Electron Worker URL，无 CDN loader path。主包 `index-CTELHjqv.js` 4784.99 kB / gzip 1254.58 kB。

浏览器用例：Chromium 工作流 1 通过；Chrome 与 Edge 工作流各 1 通过；六张 channel 截图测试全部通过。E2E 由 Playwright webServer 执行 `pnpm build && pnpm preview`（4173）与 `pnpm dev:echo`（4174），未连接真实 POC4 后端。

## Visual Verification

六张 PNG 由本轮 `pnpm test:e2e:channels` 再次写出，字节与像素与仓库已提交证据一致（未产生新的 git 差异）：

| 文件 | 字节 | 像素 |
|---|---:|---|
| `poc4/docs/evidence/stage-0/chrome-1280x720.png` | 26479 | 1280×720 |
| `poc4/docs/evidence/stage-0/chrome-1440x900.png` | 28423 | 1440×900 |
| `poc4/docs/evidence/stage-0/chrome-1920x1080.png` | 31098 | 1920×1080 |
| `poc4/docs/evidence/stage-0/edge-1280x720.png` | 26479 | 1280×720 |
| `poc4/docs/evidence/stage-0/edge-1440x900.png` | 28423 | 1440×900 |
| `poc4/docs/evidence/stage-0/edge-1920x1080.png` | 31098 | 1920×1080 |

同 viewport 的 Chrome / Edge 文件大小相同。人工打开 1280 / 1440 / 1920 画面：

- 左侧 Workspace + Mock file tree 非空；顶部 File / Run / Terminal 三个主 tab 完整，File 为选中态。
- 编辑器 tabs（pom.xml / App.java / AppTest.java）可见；Monaco 为 vs-dark，有行号、XML 语法着色和 minimap，不是纯色空白。
- 1280 px 侧栏与主区分离，按钮与 tab 未被截断；E2E 断言 `documentElement`/`body` 无横向溢出，且 `aside` 右缘不超过 `main` 左缘。
- 1440 / 1920 px 侧栏保持约 256 px，剩余宽度给编辑器画布，不是面板被不合理拉扁。
- 侧栏是阶段 0 mock 文案，视觉偏空，但不空白、不重叠、不挡住操作。

## Boundary Verification

1. `pnpm test:boundary` 退出 0：三条规则测试通过，源码扫描打印 `Browser boundary check passed.`
2. 本机 `rg` 不在 PATH（`Get-Command rg` / `where.exe rg` 均失败）。等价扫描（无匹配 = 通过，有匹配 = 失败）：

```powershell
$patterns = @(
  'window\.electronAPI',
  'from .*electron',
  'node-pty',
  'electron-vite',
  'electron-log',
  '[A-Za-z]:\\(Users|DeepLearning|Projects)\\',
  '/Users/'
)
$targets = @()
$targets += Get-ChildItem -Path 'poc4\frontend\src' -Recurse -File
$targets += Get-Item 'poc4\frontend\package.json'
$matches = Select-String -Path ($targets.FullName) -Pattern $patterns
```

结果：`FORBIDDEN_MATCH_COUNT=0`，脚本正常结束。
3. `git diff --check` 无输出，退出 0。
4. `git status --short` 在验证后为空（无未提交改动）。
5. UTF-8 BOM：字面 `Get-ChildItem poc4\frontend -Recurse` 会进入 `node_modules`（超长路径无法读取，且依赖 README 可能带 BOM）。对仓库跟踪文本与排除 `node_modules`/`dist`/`test-results`/`playwright-report` 后的工程文件扫描：48 个 `.ts/.tsx/.js/.mjs/.json/.css/.md/.html/.yaml/.yml`，BOM_FOUND=0。

## Observed Migration Cost

`fbfddb2..399f778` 的 `poc4/frontend` 共 51 文件、+6131 行。去掉 lockfile 后约 +2545 行，覆盖脚手架、边界守卫、设计系统、Tabs、Monaco、xterm、echo server 与 E2E。

从 EnsoAI `5aa294a` 裁剪迁入的显示层（numstat 新增行）：

| 文件 | 新增行 |
|---|---:|
| `src/styles/globals.css` | 177 |
| `src/lib/utils.ts` | 6 |
| `src/lib/motion.ts` | 31 |
| `src/components/ui/button.tsx` | 72 |
| `src/components/files/fileIcons.tsx` | 121 |
| `src/components/files/EditorTabs.tsx` | 129 |
| `src/components/terminal/ResizeHandle.tsx` | 58 |
| `src/components/terminal/TerminalSearchBar.tsx` | 213 |
| 小计 | 807 |

浏览器生命周期为重写而非复制 Electron：`monacoSetup.ts` 19、`monacoModels.ts` 27、`MonacoPanel.tsx` 90、`WorkbenchSpike.tsx` 73、`TerminalPanel.tsx` 215、`TerminalSession.ts` 63、`WebSocketTerminalTransport.ts` 118、`protocol.ts` 29。EnsoAI 原 `FileTree.tsx` / `EditorArea.tsx` / `useXterm.ts` 未整文件迁入。

若只复用设计变量和 Button，阶段 0 仍需从零实现 Tabs、图标、Monaco Worker、模型 URI、xterm transport 与销毁。本次已在生产构建和 Chrome/Edge 中证明这些交互可独立运行，收益明显高于“仅抄 CSS 变量”。设计文档 25%–40% 全前端节省仍是后续阶段的工程判断，不是本 Spike 能量出的全仓工期比例；阶段 0 本身支持继续选择性迁移，而不是退回只留主题。

## Decision

对照阶段 0 决策门六项，依据本轮证据逐项判定：

1. `pnpm build` 与 `pnpm typecheck` 通过：是。退出码均为 0；Vite `built in 41.14s`，并产出五个独立 Monaco Worker。
2. Chrome/Edge 中 Monaco Worker、模型切换和 dirty 状态正常：是。channel 工作流在两浏览器通过：`.monaco-editor` 可见，console error 为空，`pom.xml` 写入 `SPIKEDIRTY` 后 tab 带 `*`，切到 `App.java` 再切回内容与 dirty 仍在；截图显示 XML 着色而非空白画布。
3. xterm 输入、输出、resize、disconnect、dispose 和新会话正常：是。E2E 验证 Connect 后 status=`connected` 且 last-output 含 `POC4 browser terminal ready`，输入 `K` 回显一次，Disconnect 后旧 `/terminal` WebSocket 关闭，再 Connect 仅 1 条打开 socket 且 `Q` 不加倍。`TerminalSession` 单测覆盖 dispose 一次、dispose 后不转发输出、仅活动会话 resize。面板在 FitAddon.fit 后调用 `session.resize`。
4. 1280 px 无重叠和不可达操作：是。Chromium/Chrome/Edge 工作流断言无横向溢出且侧栏不覆盖主区；1280 截图中 File / Run / Terminal 与编辑器 tabs 均可点到。
5. 生产依赖和源码没有 Electron、Node PTY 或本机绝对路径：是。`pnpm test:boundary` 通过；`package.json` + `src` 的 Select-String 禁止项扫描 0 匹配。
6. 实际迁移仍比仅复用设计变量有明显收益：是。已迁入并跑通 Tabs / 图标 / 搜索条 / 主题，同时用较短的浏览器 transport 替换了 Electron PTY；丢掉这些已验证组件会把已通过的编辑器与终端工作再做一遍。

六项均为真，因此决策为：

**CONTINUE_SELECTIVE_MIGRATION**

不编写阶段 1 计划，停在本决策门等待确认。

## Confidence

设计文档在 Spike 前将整体置信度写为 84%，缺口是浏览器生产构建尚未跑过。本轮六条自动命令、禁止项扫描和六张截图补上了该缺口。对“继续选择性迁移、而不是放弃工作台组件”的置信度更新为 **90%**。

仍未由阶段 0 覆盖、因此不能提高到接近确定的事项：

- 后续阶段 FileTree / 文件 API / 运行锁的拆分工作量，25%–40% 全前端节省尚未计量。
- 大文件、持续终端输出和 WebGL 降级性能。
- 真实 Job WebSocket、ticket、断线恢复和命令审计（本 Spike 只用本地 echo）。
- Chrome / Edge 不在 PATH 时依赖标准安装路径；其他机器若无该路径，channel 任务会无法启动。
- 主包约 4.8 MB，超过 Vite 500 kB 提示阈值；阶段 0 不以此失败，但后续需要代码分割。
