# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual\ai-ui.spec.ts >> native effort keyboard ticks drag focus and retained UI state
- Location: tests\visual\ai-ui.spec.ts:45:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByLabel('Task goal')
    - locator resolved to <textarea rows="4" id="agent-task-goal" class="min-h-16 w-full resize-y rounded-md border bg-background p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64">保留这段未发送输入</textarea>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div id="_r_a_" data-open="" role="dialog" tabindex="-1" data-side="top" data-align="start" data-base-ui-focusable="" class="manao-ai-effort-popup" aria-labelledby="base-ui-_r_h_">…</div> from <div id="_r_f_" data-base-ui-portal="">…</div> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div id="_r_a_" data-open="" role="dialog" tabindex="-1" data-side="top" data-align="start" data-base-ui-focusable="" class="manao-ai-effort-popup" aria-labelledby="base-ui-_r_h_">…</div> from <div id="_r_f_" data-base-ui-portal="">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 100ms
    108 × waiting for element to be visible, enabled and stable
        - element is visible, enabled and stable
        - scrolling into view if needed
        - done scrolling
        - <div id="_r_a_" data-open="" role="dialog" tabindex="-1" data-side="top" data-align="start" data-base-ui-focusable="" class="manao-ai-effort-popup" aria-labelledby="base-ui-_r_h_">…</div> from <div id="_r_f_" data-base-ui-portal="">…</div> subtree intercepts pointer events
      - retrying click action
        - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - link "Skip to editor" [ref=e4] [cursor=pointer]:
    - /url: "#workbench-editor"
  - banner [ref=e5]:
    - link "Back to projects" [ref=e6] [cursor=pointer]:
      - /url: /projects
    - generic [ref=e12]:
      - heading "Alice Notebook" [level=1] [ref=e13]
      - text: Java console
    - generic [ref=e14]: 无未保存修改
    - button "切换文件面板" [expanded] [ref=e16] [cursor=pointer]
    - button "切换对话历史" [expanded] [ref=e17] [cursor=pointer]
    - button "命令面板" [ref=e18] [cursor=pointer]
    - button "运行活动，有 1 条未读" [ref=e19] [cursor=pointer]:
      - generic [ref=e20]: "1"
    - button "账户与偏好" [ref=e21] [cursor=pointer]:
      - generic [ref=e22]: A
    - button "Log out" [ref=e23] [cursor=pointer]
  - generic [ref=e24]:
    - complementary "Project files" [ref=e25]:
      - generic [ref=e26]: EXPLORER
      - generic [ref=e29]:
        - generic [ref=e30]:
          - button "New file" [ref=e31] [cursor=pointer]
          - button "New folder" [ref=e35] [cursor=pointer]
          - button "Rename" [disabled]
          - button "Delete" [disabled]
          - button "Refresh" [ref=e38] [cursor=pointer]
          - button "Collapse all folders" [ref=e44] [cursor=pointer]
        - tree "Files" [ref=e48]:
          - treeitem "assets" [level=1] [ref=e49] [cursor=pointer]
          - treeitem "docs" [level=1] [ref=e55] [cursor=pointer]
          - treeitem "src" [level=1] [ref=e61] [cursor=pointer]
          - treeitem ".gitignore" [level=1] [ref=e67] [cursor=pointer]
          - treeitem "pom.xml" [level=1] [ref=e72] [cursor=pointer]
          - treeitem "README.md" [level=1] [ref=e77] [cursor=pointer]
    - generic [ref=e82]:
      - tablist "Workbench panels" [ref=e83]:
        - tab "File" [ref=e84] [cursor=pointer]: 代码
        - tab "Run" [ref=e90] [cursor=pointer]: 运行记录
        - tab "AI" [selected] [ref=e93] [cursor=pointer]
        - button "切换专注模式" [ref=e97] [cursor=pointer]
      - tabpanel "AI" [ref=e104]:
        - region "AI 会话" [ref=e105]:
          - region "AI task" [ref=e106]:
            - generic [ref=e107]:
              - heading "书籍接口与阅读排版" [level=2] [ref=e108]
              - button "压缩上下文" [ref=e109] [cursor=pointer]
            - generic [ref=e110]:
              - region "会话历史" [ref=e111]:
                - article [ref=e112]:
                  - generic [ref=e113]: 本轮状态：COMPLETED
                  - generic [ref=e114]: 用户
                  - generic [ref=e115]: 请核对第 1 项接口，保留错误状态与上下文说明。
                - article [ref=e116]:
                  - generic [ref=e117]: AI
                  - generic [ref=e118]:
                    - heading "第 1 轮说明" [level=2] [ref=e119]
                    - paragraph [ref=e120]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e121]:
                  - generic [ref=e122]: 本轮状态：COMPLETED
                  - generic [ref=e123]: 用户
                  - generic [ref=e124]: 请核对第 3 项接口，保留错误状态与上下文说明。
                - article [ref=e125]:
                  - generic [ref=e126]: AI
                  - generic [ref=e127]:
                    - heading "第 3 轮说明" [level=2] [ref=e128]
                    - paragraph [ref=e129]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e130]:
                  - generic [ref=e131]: 本轮状态：COMPLETED
                  - generic [ref=e132]: 用户
                  - generic [ref=e133]: 请核对第 5 项接口，保留错误状态与上下文说明。
                - article [ref=e134]:
                  - generic [ref=e135]: AI
                  - generic [ref=e136]:
                    - heading "第 5 轮说明" [level=2] [ref=e137]
                    - paragraph [ref=e138]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e139]:
                  - generic [ref=e140]: 本轮状态：COMPLETED
                  - generic [ref=e141]: 用户
                  - generic [ref=e142]: 请核对第 7 项接口，保留错误状态与上下文说明。
                - article [ref=e143]:
                  - generic [ref=e144]: AI
                  - generic [ref=e145]:
                    - heading "第 7 轮说明" [level=2] [ref=e146]
                    - paragraph [ref=e147]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e148]:
                  - generic [ref=e149]: 本轮状态：COMPLETED
                  - generic [ref=e150]: 用户
                  - generic [ref=e151]: 请核对第 9 项接口，保留错误状态与上下文说明。
                - article [ref=e152]:
                  - generic [ref=e153]: AI
                  - generic [ref=e154]:
                    - heading "第 9 轮说明" [level=2] [ref=e155]
                    - paragraph [ref=e156]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e157]:
                  - generic [ref=e158]: 本轮状态：COMPLETED
                  - generic [ref=e159]: 用户
                  - generic [ref=e160]: 请核对第 11 项接口，保留错误状态与上下文说明。
                - article [ref=e161]:
                  - generic [ref=e162]: AI
                  - generic [ref=e163]:
                    - heading "第 11 轮说明" [level=2] [ref=e164]
                    - paragraph [ref=e165]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e166]:
                  - generic [ref=e167]: 本轮状态：COMPLETED
                  - generic [ref=e168]: 用户
                  - generic [ref=e169]: 请核对第 13 项接口，保留错误状态与上下文说明。
                - article [ref=e170]:
                  - generic [ref=e171]: AI
                  - generic [ref=e172]:
                    - heading "第 13 轮说明" [level=2] [ref=e173]
                    - paragraph [ref=e174]: 检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。检查现有代码、运行记录和用户要求，保持原有业务契约。
                - article [ref=e175]:
                  - generic [ref=e176]: AI
                  - group [ref=e177]:
                    - generic "思考过程" [ref=e178] [cursor=pointer]
                - article [ref=e179]:
                  - generic [ref=e180]: AI
                  - generic [ref=e181]:
                    - heading "书籍接口整理" [level=1] [ref=e182]
                    - paragraph [ref=e183]:
                      - text: 已保留项目已有的运行与上下文能力。
                      - strong [ref=e184]: 下面是固定 UI 验收内容
                      - text: 。
                    - table [ref=e186]:
                      - rowgroup [ref=e187]:
                        - row [ref=e188]:
                          - columnheader "接口" [ref=e189]
                          - columnheader "说明" [ref=e190]
                          - columnheader "长字段" [ref=e191]
                      - rowgroup [ref=e192]:
                        - row [ref=e193]:
                          - cell "GET /books" [ref=e194]
                          - cell "查询书籍" [ref=e195]
                          - cell "字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段字段" [ref=e196]
                        - row [ref=e197]:
                          - cell "POST /books" [ref=e198]
                          - cell "新建书籍" [ref=e199]
                          - cell "title / author" [ref=e200]
                    - code [ref=e202]: String endpoint = "books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/books/"; System.out.println(endpoint);
                    - list [ref=e203]:
                      - listitem [ref=e204]: Markdown 列表
                      - listitem [ref=e205]: 表格与代码应局部横向滚动
                - article [ref=e206]:
                  - generic [ref=e207]: 工具
                  - generic [ref=e208]: read_file 已完成
                  - button "查看工具结果" [ref=e210] [cursor=pointer]
                - article [ref=e211]:
                  - generic [ref=e212]: 工具
                  - generic [ref=e213]: app_http_get 已完成
                  - button "查看工具结果" [ref=e215] [cursor=pointer]
                - status [ref=e216]: 同步中
              - generic [ref=e217]:
                - generic [ref=e218]:
                  - generic [ref=e219]: Status
                  - generic [ref=e220]: COMPLETED
                - generic [ref=e221]: 本轮推理强度：high
                - generic [ref=e222]:
                  - heading "Changed paths" [level=3] [ref=e223]
                  - list [ref=e224]:
                    - listitem [ref=e225]: src/main/java/example/BookController.java
            - generic [ref=e226]:
              - generic [ref=e227]: Task goal
              - textbox "Task goal" [ref=e228]: 保留这段未发送输入
              - generic [ref=e229]:
                - generic [ref=e230]:
                  - button "推理强度 · 最高" [expanded] [ref=e232] [cursor=pointer]:
                    - text: 推理强度 · 最高
                    - generic [ref=e233]: ⌄
                  - dialog [ref=e237]:
                    - heading "推理强度" [level=2] [ref=e238]
                    - generic [ref=e239]:
                      - generic: 最高
                      - slider "推理强度" [active] [ref=e240] [cursor=pointer]: "3"
                    - generic [ref=e241]:
                      - button "关闭" [ref=e242] [cursor=pointer]
                      - button "低" [ref=e243] [cursor=pointer]
                      - button "高" [ref=e244] [cursor=pointer]
                      - button "最高" [pressed] [ref=e245] [cursor=pointer]
                    - paragraph [ref=e246]: 使用最高的推理强度。
                  - progressbar "上下文占用" [ref=e249]:
                    - generic [ref=e253]: 约 0.3%
                - button "Start task" [ref=e255] [cursor=pointer]
    - complementary "对话历史" [ref=e256]:
      - navigation "会话列表" [ref=e260]:
        - button "新建会话" [ref=e261] [cursor=pointer]
        - generic [ref=e262]:
          - button "书籍接口与阅读排版" [pressed] [ref=e263] [cursor=pointer]
          - button "更多会话" [ref=e265] [cursor=pointer]
  - contentinfo [ref=e266]:
    - status [ref=e267]: 工作区可编辑
    - generic [ref=e269]: Java / Maven
    - generic [ref=e270]: MANAO CLOUD LAB
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
> 68  |   await trigger.click(); await goal.click(); await expect(slider).toBeHidden();
      |                                     ^ Error: locator.click: Test timeout of 60000ms exceeded.
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
  95  |   await expect(page.getByText('run-000001', { exact: true }).first()).toBeVisible();
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