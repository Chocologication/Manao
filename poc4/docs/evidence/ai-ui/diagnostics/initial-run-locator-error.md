# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual\ai-ui.spec.ts >> history pagination empty create and original Run navigation
- Location: tests\visual\ai-ui.spec.ts:79:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  getByText('run-000001', { exact: true }).first()
Expected: visible
Received: hidden
Timeout:  10000ms

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByText('run-000001', { exact: true }).first()
    23 × locator resolved to <code title="run-000001">run-000001</code>
       - unexpected value "hidden"

```

```yaml
- link "Skip to editor":
  - /url: "#workbench-editor"
- banner:
  - link "Back to projects":
    - /url: /projects
  - heading "Alice Notebook" [level=1]
  - text: Java console 无未保存修改
  - button "切换文件面板" [expanded]
  - button "切换项目洞察" [expanded]
  - button "命令面板"
  - button "运行活动，有 1 条未读": "1"
  - button "账户与偏好"
  - button "Log out"
- complementary "Project files":
  - text: EXPLORER
  - button "New file"
  - button "New folder"
  - button "Rename" [disabled]
  - button "Delete" [disabled]
  - button "Refresh"
  - button "Collapse all folders"
  - tree "Files":
    - treeitem "assets" [level=1]
    - treeitem "docs" [level=1]
    - treeitem "src" [level=1]
    - treeitem ".gitignore" [level=1]
    - treeitem "pom.xml" [level=1]
    - treeitem "README.md" [level=1]
- tablist "Workbench panels":
  - tab "File": 代码
  - tab "Run" [selected]: 运行记录
  - tab "AI"
  - button "切换专注模式"
- tabpanel "Run":
  - region "Run":
    - toolbar "Run controls":
      - button "Start run"
      - button "Stop run" [disabled]
      - status "Run state":
        - text: 运行成功
        - code: SUCCEEDED
      - text: mvn -q -DskipTests compile exec:java Finished 2026-10-20T12:46:06.366Z Java 17 · Maven 3 · timeout 1800s
    - status:
      - text: 历史运行
      - code: run-000001
    - complementary "Recent runs":
      - heading "运行历史 / HISTORY" [level=2]
      - list "Recent runs":
        - listitem:
          - button "2026-10-20T12:46:06.364Z SUCCEEDED": 运行成功 10/20 20:46
    - status "Log connection": Complete
    - textbox "搜索日志":
      - /placeholder: 搜索日志…
    - button "复制日志"
    - button "下载日志"
    - button "导出运行证据"
    - status
    - button "滚动到最新日志"
    - region "Run logs": ensoai-stage4-seed-log
- complementary "运行洞察":
  - paragraph: RUN INSIGHTS
  - heading "运行洞察" [level=2]
  - text: 基于当前项目与运行记录
  - link "项目概览":
    - /url: /projects/prj-alice-notebook/overview
  - heading "环境与权限" [level=3]
  - term: 模板
  - definition: Java console
  - term: 工作区
  - definition: 环境就绪
  - term: 文件权限
  - definition: 可编辑
  - heading "最近运行" [level=3]
  - text: 运行成功
  - term: 命令
  - definition: mvn -q -DskipTests compile exec:java
  - term: 运行编号
  - definition: run-000001
  - term: 耗时
  - definition: 0 秒
  - term: 退出码
  - definition: "0"
  - term: 日志序号
  - definition: "#1"
  - term: Workspace revision
  - definition: mock-rev-0001
  - button "查看运行与日志"
  - region "运行状态映射预览":
    - heading "运行状态轨迹" [level=3]
    - text: 预览
    - list:
      - listitem:
        - strong: 运行环境
        - text: 项目状态：环境就绪
      - listitem:
        - strong: 代码执行
        - text: 运行成功
      - listitem:
        - strong: 运行证据
        - text: "已记录至 #1"
    - paragraph: 按 Run 状态整理的界面预览，不代表后端实时阶段事件。
  - region "AI 诊断预览":
    - heading "AI 诊断" [level=3]
    - text: 预览 · 未接入
    - paragraph: 当前不会生成 AI 诊断结论；接入真实 AI 服务后再展示分析结果。
- contentinfo:
  - status: 工作区可编辑
  - text: Java / Maven MANAO CLOUD LAB
```

# Test source

```ts
  1   | import { expect, test, type Page } from '@playwright/test';
  2   | import { mkdir } from 'node:fs/promises';
  3   | import { resolve } from 'node:path';
  4   |
  5   | const screenshots = resolve('..', 'docs/evidence/ai-ui/screenshots');
  6   | async function openAI(page: Page, theme = 'lab') {
  7   |   await page.addInitScript(t => localStorage.setItem('manao.appearance.v1', t), theme);
  8   |   await page.goto('/login');
  9   |   await page.getByLabel('Username').fill('alice');
  10  |   await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  11  |   await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  12  |   await page.getByRole('article', { name: 'Alice Notebook' }).getByRole('link', { name: 'Open', exact: true }).click();
  13  |   await page.getByRole('tab', { name: 'AI', exact: true }).click();
  14  |   await expect(page.getByRole('heading', { name: '书籍接口与阅读排版', exact: true })).toBeVisible();
  15  |   await expect(page.locator('[data-message-seq]')).toHaveCount(18);
  16  |   await expect(page.getByLabel('Task goal')).toBeEnabled();
  17  | }
  18  | async function capture(page: Page, name: string) {
  19  |   await mkdir(screenshots, { recursive: true });
  20  |   await page.screenshot({ path: resolve(screenshots, name), fullPage: true });
  21  | }
  22  | async function noOverflow(page: Page) {
  23  |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  24  |   const scroll = page.locator('.manao-ai-scroll');
  25  |   expect(await scroll.evaluate(e => e.scrollHeight > e.clientHeight)).toBe(true);
  26  |   await expect(page.getByRole('button', { name: 'Start task', exact: true })).toBeInViewport();
  27  | }
  28  |
  29  | for (const theme of ['lab', 'graphite', 'light']) test(`reading layout ${theme} 1440x900`, async ({ page }) => {
  30  |   await page.setViewportSize({ width: 1440, height: 900 });
  31  |   await openAI(page, theme);
  32  |   await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  33  |   await expect(page.getByRole('navigation', { name: '会话列表' })).toBeVisible();
  34  |   await expect(page.getByRole('progressbar', { name: '上下文占用' })).toHaveAttribute('aria-valuetext', /2,633/);
  35  |   await expect(page.getByRole('button', { name: '压缩上下文', exact: true })).toBeEnabled();
  36  |   await page.getByText('思考过程', { exact: true }).click();
  37  |   await page.getByRole('button', { name: '查看工具结果', exact: true }).first().click();
  38  |   await expect(page.getByText('# Fixed UI fixture', { exact: true })).toBeVisible();
  39  |   await noOverflow(page);
  40  |   await capture(page, `${theme}-1440x900.png`);
  41  |   const localScroll = await page.locator('.ai-markdown pre, .ai-markdown-table').evaluateAll(es => es.map(e => ({ width: e.clientWidth, scroll: e.scrollWidth })));
  42  |   expect(localScroll.some(e => e.scroll > e.width)).toBe(true);
  43  | });
  44  |
  45  | test('native effort keyboard ticks drag focus and retained UI state', async ({ page }) => {
  46  |   await page.setViewportSize({ width: 1024, height: 768 });
  47  |   await openAI(page);
  48  |   const goal = page.getByLabel('Task goal');
  49  |   await goal.fill('保留这段未发送输入');
  50  |   let trigger = page.getByRole('button', { name: /推理强度 ·/ });
  51  |   await trigger.click();
  52  |   const slider = page.getByRole('slider', { name: '推理强度', exact: true });
  53  |   await slider.focus();
  54  |   for (const [key, value, label] of [['Home', '0', '关闭'], ['ArrowRight', '1', '低'], ['ArrowRight', '2', '高'], ['End', '3', '最高']] as const) {
  55  |     await slider.press(key); await expect(slider).toHaveValue(value); await expect(slider).toHaveAttribute('aria-valuetext', label);
  56  |     const capsule = await page.locator('.manao-ai-effort-capsule').boundingBox();
  57  |     const popup = await page.locator('.manao-ai-effort-popup').boundingBox();
  58  |     expect(capsule!.x).toBeGreaterThanOrEqual(popup!.x);
  59  |     expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(popup!.x + popup!.width);
  60  |   }
  61  |   await page.getByRole('button', { name: '低', exact: true }).click();
  62  |   await expect(slider).toHaveValue('1');
  63  |   const box = await slider.boundingBox();
  64  |   await page.mouse.move(box!.x + 32, box!.y + box!.height / 2);
  65  |   await page.mouse.down(); await page.mouse.move(box!.x + box!.width - 32, box!.y + box!.height / 2, { steps: 12 }); await page.mouse.up();
  66  |   await expect(slider).toHaveValue('3');
  67  |   await slider.press('Escape'); await expect(slider).toBeHidden(); await expect(trigger).toBeFocused();
  68  |   await trigger.click(); await goal.click(); await expect(slider).toBeHidden();
  69  |   await trigger.click(); await page.getByRole('tab', { name: 'File', exact: true }).click();
  70  |   await expect(slider).toBeHidden(); await expect(page.getByRole('navigation', { name: '会话列表' })).toBeHidden();
  71  |   await page.getByRole('tab', { name: 'AI', exact: true }).click();
  72  |   await expect(goal).toHaveValue('保留这段未发送输入');
  73  |   await page.getByRole('button', { name: '切换对话历史', exact: true }).click();
  74  |   await page.getByRole('button', { name: '切换对话历史', exact: true }).click();
  75  |   await expect(goal).toHaveValue('保留这段未发送输入');
  76  |   await noOverflow(page); await capture(page, 'lab-1024x768.png');
  77  | });
  78  |
  79  | test('history pagination empty create and original Run navigation', async ({ page }) => {
  80  |   await openAI(page);
  81  |   const taskPosts: string[] = [];
  82  |   page.on('request', r => { if (r.method() === 'POST' && /\/tasks$|\/agent-tasks$/.test(new URL(r.url()).pathname)) taskPosts.push(r.url()); });
  83  |   await page.getByRole('button', { name: '更多会话', exact: true }).click();
  84  |   await page.getByRole('button', { name: '下一轮项目讨论', exact: true }).click();
  85  |   await expect(page.locator('[data-message-seq]')).toHaveCount(0);
  86  |   await page.getByRole('button', { name: '新建会话', exact: true }).click();
  87  |   await expect(page.getByRole('heading', { name: '新建空会话', exact: true })).toBeVisible();
  88  |   expect(taskPosts).toEqual([]);
  89  |   await page.getByRole('button', { name: '书籍接口与阅读排版', exact: true }).click();
  90  |   await page.getByRole('button', { name: '查看工具结果', exact: true }).last().click();
  91  |   await page.getByRole('button', { name: 'View run', exact: true }).click();
  92  |   await expect(page.getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute('aria-selected', 'true');
  93  |   await expect(page.getByRole('button', { name: '切换项目洞察', exact: true })).toBeVisible();
  94  |   await expect(page.getByRole('navigation', { name: '会话列表' })).toBeHidden();
> 95  |   await expect(page.getByText('run-000001', { exact: true }).first()).toBeVisible();
      |                                                                       ^ Error: expect(locator).toBeVisible() failed
  96  | });
  97  |
  98  | for (const width of [1023, 390]) test(`history drawer and composer ${width}`, async ({ page }) => {
  99  |   await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
  100 |   await openAI(page);
  101 |   const toggle = page.getByRole('button', { name: '切换对话历史', exact: true });
  102 |   if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
  103 |   await toggle.click();
  104 |   const drawer = page.getByRole('dialog', { name: '对话历史', exact: true });
  105 |   await expect(drawer).toBeVisible();
  106 |   for (let i = 0; i < 6; i++) { await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab'); expect(await drawer.evaluate(e => e.contains(document.activeElement))).toBe(true); }
  107 |   await capture(page, `lab-${width}-history.png`);
  108 |   await page.keyboard.press('Escape'); await expect(drawer).toBeHidden(); await expect(toggle).toBeFocused();
  109 |   const goal = page.getByLabel('Task goal'); await goal.fill('窄屏输入保持可见');
  110 |   await goal.evaluate(e => { e.style.height = '220px'; });
  111 |   await noOverflow(page);
  112 |   await page.getByRole('button', { name: /推理强度 ·/ }).click();
  113 |   await expect(page.getByRole('slider', { name: '推理强度', exact: true })).toBeInViewport();
  114 |   await capture(page, `lab-${width}-slider-input.png`);
  115 | });
  116 |
```