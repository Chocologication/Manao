# EnsoAI Stage 0 Browser Spike Result

## Source

- 日期：`2026-08-21`
- 分支：`poc4/ensoai-stage-0-spike`
- 本轮验证树：`7c3caa5`（`git rev-parse --short HEAD`，含面板保持挂载与跨面板 E2E）
- 前一报告树：`d92885a`（阶段 0 初版决策）；本轮在其上追加 `7c3caa5`
- EnsoAI 来源：`D:\DeepLearning\MyProjects\Enso_AI` 提交 `5aa294a`
- 许可证记录：`poc4/frontend/THIRD_PARTY_NOTICES.md`（MIT，来源提交 `5aa294a`）
- 行数统计：`git diff --shortstat fbfddb2 HEAD -- poc4/frontend` → 51 个文件，+6277。其中 `pnpm-lock.yaml` +3586；其余前端源与配置 +2691。

本报告所有退出码、测试数、构建时间、worker 资源和扫描结果均来自 `7c3caa5` 上的新鲜运行，不复用先前任务日志。

## Automated Verification

工作目录：`poc4/frontend`。六条命令均退出 0。

| 命令 | 退出码 | 观察结果 |
|---|---:|---|
| `pnpm test:boundary` | 0 | node:test 3 pass / 0 fail（`duration_ms 126.0317`）；随后打印 `Browser boundary check passed.` |
| `pnpm typecheck` | 0 | `tsc -b --pretty false` 无诊断输出 |
| `pnpm test` | 0 | Vitest 3.2.7：Test Files 7 passed (7)；Tests 17 passed (17)；Duration 18.10s。stderr 仅 jsdom `HTMLCanvasElement.getContext` 未实现提示，不计入失败 |
| `pnpm build` | 0 | 内含 typecheck；Vite 7.3.6 production client；`3363 modules transformed`；`built in 51.53s`。存在 >500 kB chunk 提示，构建仍成功 |
| `pnpm test:e2e` | 0 | Playwright Chromium：Running 6 tests using 1 worker；3 passed（工作流 + dirty 跨面板 + 终端会话保持）；3 skipped（截图仅 chrome/edge）；合计 1.1m |
| `pnpm test:e2e:channels` | 0 | Playwright chrome + edge：Running 12 tests using 2 workers；12 passed（两浏览器 × 3 条工作流/生命周期 + 六张 viewport 截图）；合计 1.2m |

Vitest 排除 `scripts/**` 与 `tests/e2e/**` 仍有效。本轮 `src/**` 单测为 17 个（新增 WorkbenchSpike 保持挂载用例）。

生产构建独立 Monaco Worker（本次 `dist/assets`）：

| Asset | 体积 |
|---|---:|
| `editor.worker-C2_AfrSl.js` | 251.74 kB（251735 B） |
| `json.worker-C838mOW9.js` | 383.01 kB（383014 B） |
| `html.worker-eZJr__P7.js` | 693.12 kB（693120 B） |
| `css.worker-NZNbQL3P.js` | 1030.32 kB（1030315 B） |
| `ts.worker-BfwyojP3.js` | 7010.07 kB（7010073 B） |

无 Electron Worker URL，无 CDN loader path。主包 `index-CjHsX4jR.js` 4785.28 kB / gzip 1254.62 kB。

浏览器用例：Chromium 3 通过（含 dirty 跨面板与终端会话保持）；Chrome / Edge 各 3 条功能用例通过，并发送 `terminal.resize` 帧；六张 channel 截图测试全部通过。E2E 由 Playwright webServer 执行 `pnpm build && pnpm preview`（4173）与 `pnpm dev:echo`（4174），未连接真实 POC4 后端。

## Visual Verification

六张 PNG 由本轮 `pnpm test:e2e:channels` 再次写出，用于人工核对视觉不变量，不是 golden-file 断言。PNG 字节可能因浏览器渲染时机变化，不能用文件大小、像素哈希或“与仓库已提交证据字节一致”来证明通过。

| 文件 | 尺寸 |
|---|---|
| `poc4/docs/evidence/stage-0/chrome-1280x720.png` | 1280×720 |
| `poc4/docs/evidence/stage-0/chrome-1440x900.png` | 1440×900 |
| `poc4/docs/evidence/stage-0/chrome-1920x1080.png` | 1920×1080 |
| `poc4/docs/evidence/stage-0/edge-1280x720.png` | 1280×720 |
| `poc4/docs/evidence/stage-0/edge-1440x900.png` | 1440×900 |
| `poc4/docs/evidence/stage-0/edge-1920x1080.png` | 1920×1080 |

人工打开 1280 / 1440 / 1920 画面，核对以下视觉不变量：

- 尺寸正确：每张截图对应其文件名中的 viewport。
- Monaco 画布非空白：编辑器 tabs（pom.xml / App.java / AppTest.java）可见；Monaco 为 vs-dark，有行号、XML 语法着色和 minimap，不是纯色空白。
- 无重叠：左侧 Workspace + Mock file tree 与主区分离；顶部 File / Run / Terminal 三个主 tab 完整，File 为选中态；`aside` 右缘不超过 `main` 左缘。
- 无溢出：E2E 断言 `documentElement`/`body` 无横向溢出；1440 / 1920 px 侧栏保持约 256 px，剩余宽度给编辑器画布，不是面板被不合理拉扁。
- 控件可达：1280 px 下按钮与 tab 未被截断，File / Run / Terminal 与编辑器 tabs 均可点到。侧栏是阶段 0 mock 文案，视觉偏空，但不空白、不重叠、不挡住操作。

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
3. `git diff --check` 与 `git diff --check d92885a HEAD` 均无空白错误输出。本轮在最终验证树 `7c3caa5` 上执行，不是 `399f778`。`src/test/setup.ts` 末尾已去掉多余空行。
4. `git status --short` 在验证后为空（无未提交改动）。六张 PNG 不是 golden-file；字节差异不单独构成失败。
5. UTF-8 BOM：排除 `node_modules`/`dist`/`test-results`/`playwright-report` 后扫描 49 个 `.ts/.tsx/.js/.mjs/.json/.css/.md/.html/.yaml/.yml`，BOM_FOUND=0。

## Observed Migration Cost

`fbfddb2..7c3caa5` 的 `poc4/frontend` 共 51 文件、+6277 行。去掉 lockfile 后约 +2691 行，覆盖脚手架、边界守卫、设计系统、Tabs、Monaco、xterm、echo server、跨面板生命周期与 E2E。

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

1. `pnpm build` 与 `pnpm typecheck` 通过：是。退出码均为 0；Vite `built in 51.53s`，并产出五个独立 Monaco Worker。
2. Chrome/Edge 中 Monaco Worker、模型切换和 dirty 状态正常：是。channel 工作流在两浏览器通过：`.monaco-editor` 可见，console error 为空，`pom.xml` 写入 `SPIKEDIRTY` 后 tab 带 `*`，切到 `App.java` 再切回、以及切到 Run 再切回 File，内容与 dirty 仍在；截图显示 XML 着色而非空白画布。
3. xterm 输入、输出、resize、disconnect、dispose 和新会话正常：是。E2E 验证 Connect 后 status=`connected` 且 last-output 含 `POC4 browser terminal ready`，出站 JSON 含 `terminal.resize` 且 cols/rows > 0，输入 `K` 回显一次，Disconnect 后旧 `/terminal` WebSocket 关闭，再 Connect 仅 1 条打开 socket 且 `Q` 不加倍。切到 File 后再回到 Terminal，socket 仍为 1 且 status 仍为 `connected`。`TerminalSession` 单测覆盖 dispose 一次、dispose 后不转发输出、仅活动会话 resize。File / Run / Terminal 三个主面板保持挂载，仅隐藏非活动面板；未保存的 `SPIKEDIRTY` 缓冲在切 Run 后仍在。
4. 1280 px 无重叠和不可达操作：是。Chromium/Chrome/Edge 工作流断言无横向溢出且侧栏不覆盖主区；1280 截图中 File / Run / Terminal 与编辑器 tabs 均可点到。
5. 生产依赖和源码没有 Electron、Node PTY 或本机绝对路径：是。`pnpm test:boundary` 通过；`package.json` + `src` 的 Select-String 禁止项扫描 0 匹配。
6. 实际迁移仍比仅复用设计变量有明显收益：是。已迁入并跑通 Tabs / 图标 / 搜索条 / 主题，同时用较短的浏览器 transport 替换了 Electron PTY；丢掉这些已验证组件会把已通过的编辑器与终端工作再做一遍。

六项均为真，因此决策为：

**CONTINUE_SELECTIVE_MIGRATION**

不编写阶段 1 计划，停在本决策门等待确认。

## Confidence

设计文档在 Spike 前将整体置信度写为 84%。初版 `d92885a` 补上了生产构建与 Chrome/Edge 证据，但主面板条件卸载会丢掉 dirty buffer 与终端会话。`7c3caa5` 改为三个面板保持挂载、仅隐藏非活动面板，并用失败先于修复的 E2E 锁住跨 File/Run/Terminal 行为，以及出站 `terminal.resize` 帧。对“继续选择性迁移、而不是放弃工作台组件”的置信度保持 **90%**。当前提交作为阶段 1 起点的置信度为 **80%**（不再是未修正生命周期时的 60%）。

仍未由阶段 0 覆盖、因此不能提高到接近确定的事项：

- 后续阶段 FileTree / 文件 API / 运行锁的拆分工作量，25%–40% 全前端节省尚未计量。
- 大文件、持续终端输出和 WebGL 降级性能。
- 真实 Job WebSocket、ticket、断线恢复和命令审计（本 Spike 只用本地 echo）。
- Chrome / Edge 不在 PATH 时依赖标准安装路径；其他机器若无该路径，channel 任务会无法启动。
- 主包约 4.8 MB，超过 Vite 500 kB 提示阈值；阶段 0 不以此失败，但后续需要代码分割。
