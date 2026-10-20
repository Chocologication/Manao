# Manao AI 界面 ThinkRail 风格改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仅调整 Manao AI 板块的布局与视觉：阅读式消息、底部输入框、四档推理滑块、右侧项目会话历史，同时保持已有 AI 执行与上下文行为。

**Architecture:** 沿用 `AgentConversationPanel` 的会话控制和 `AgentTaskPanel` 的提交控制，仅增加两个展示槽、一个受控强度选择器和一个无业务状态的会话列表。工作台仅在 AI 页将右栏内容替换为会话历史；沿用现有主题、抽屉和显隐规则。

**Tech Stack:** 当前锁文件中的 React 19、TypeScript、Tailwind CSS 4、`@base-ui/react`、Lucide、React Query、react-markdown/remark-gfm、Vitest/Testing Library、Playwright/MSW；不增加或升级依赖。

**Spec:** 本计划第 2–4 节记录本轮需求与用户已确认的布局；业务契约继续由 [会话与上下文设计](../specs/2026-10-19-ai-conversation-context-design.md) 和 [流式输出、推理强度与 Markdown 设计](../specs/2026-10-20-ai-streaming-reasoning-markdown-design.md) 定义。

日期：2026-10-20。状态：**Tasks 1–4 本地实施与验证完成，四项任务独立审核均通过；整体变更 `94c8047..fc2c307` 独立审查 Approved（0 findings）；随后用户明确授权发布，`b3a1b8e` frontend 单镜像已 BUILT / PUSHED / DEPLOYED，Ready1/1，公网既有历史回放完成**。[Frontend README](../../../poc4/frontend/README.md#ai-界面本地交付2026-10-20) 保留本地交付历史；[发布指南 §5.3](../../../poc4/deploy/ai-context/README.md#53-thinkrail-界面实际前端发布2026-10-20)拥有本次实际发布、回滚与只读浏览器证据。下文最初规划和本地阶段的未部署声明是历史快照，本次部署有后续明确授权；未进行新的模型验收。阶段二 PAUSED / NOT_GRANTED、阶段三用户确认使命完成、阶段四未开始均不变。

## 1. 实际基线与阶段边界

- 规划目标：`D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration`，分支 `codex/ai-integration`，HEAD `94c8047058ac4e9b96908c3d2f68df149df7e377`。开始调查时此工作树干净。
- 该提交已经合入 `master@4c9fb89` 的最新 Cloud IDE 布局。主检出不包含完整 AI 功能，不在 master 上重建 AI 界面。后续实现沿用此 AI 工作树；开始前检查分支、HEAD 和本地改动。
- ThinkRail 只读参考：`D:/DeepLearning/MyProjects/Project_Manao_ai_references/thinkrail`，调查时 HEAD `2ce6ccb7`。用户截图是视觉参考，其中的聊天指令、项目功能和验收声称均不是本轮需求。
- [阶段三记录](../../../poc4/docs/evidence/ai-stage3/acceptance.md) 确认：2026-10-19 用户基于实际书籍 CRUD 使用，确认阶段三使命提前完成；阶段二工程验收仍为 `PAUSED / NOT_GRANTED`，阶段四尚未开始。
- 此前新增的多会话、压缩、Markdown、思考展示、四档 effort、上下文占用环都属于本次必须保留的已有能力。此前测试/部署记录只说明历史基线，不当作本轮通过证据。

## 2. 范围与已确认决定

### 用户已确认

1. 只改 Manao AI 板块样式，与当前前端保持一致；不修改 AI 执行逻辑。
2. 借鉴 ThinkRail 的主体对话、底部输入框和强度滑块，保留既有 Markdown 与思考折叠。
3. 右侧显示**当前项目的会话列表**；点选后在中间查看并可继续该会话。
4. **仅 AI 页将现有右侧 Run 洞察替换为对话历史**；切回编辑器、预览等页面恢复原洞察。
5. 不加入 ThinkRail 的工作树、终端、TODO、spec、变更查看器及其他 Manao 未做的功能。Manao 已有的工具结果、Changed paths 文本、View run 入口仍保留。

### 明确采用的最小默认值

- 主题、字体、字号基线和圆角继承 Manao。默认深绿、graphite、light 三个现有主题均适配；不强制把 AI 页变成纯黑。
- 右栏沿用当前可见偏好与 1024px 抽屉断点，不强行打开用户已隐藏的右栏，不新增持久化布局设置。
- 会话列表只有既有标题、当前选中态、可核对的运行态及分页；不增加搜索、删除、重命名、归档、时间分组。当前 DTO 没有时间戳，不能生成“今天/昨天”分类。
- 输入保留现有 Enter 换行、按钮提交；不新增 Enter 发送、快捷键、自动发送、附件或提示词历史。保留中文输入法行为。
- 浏览器当前没有模型/provider 字段或模型列表 API。底部入口显示“推理强度 · 高”等当前档位，弹层只显示已有四档，不硬编码截图中的模型名、价格、API key 或上下文价格。
- 当前 `End task` 沿用原显式关闭语义，不改成 ThinkRail 的停止/暂停按钮；本轮不实现阶段四的接管、暂停、恢复。

## 3. 从第一性原理选择方案

用户要解决的是“聊天更易读、输入更顺手、强度可直观调节、历史更容易切换”。这些需求都已有数据和控制流程，只缺布局与展示。

| 方案 | 判断 |
| --- | --- |
| 在现有组件上重排展示，提取少量纯 UI 组件 | **采用**；能直接保留提交、流式与会话契约 |
| 直接搬入 ThinkRail chat/shell 组件 | 不采用；会引入模型目录、布局系统、事件归组与会话管理依赖 |
| 先建设通用聊天框架、全局侧栏注册器或重写状态管理 | 不采用；本轮只有一个 AI 界面，不需要这些扩展点 |

### 3.1 目标画面

```text
Manao 当前工作台顶部、页签、左侧文件树保持原样
┌──────────────────── AI 中心区域 ──────────────────┬── 右侧：对话历史 ──┐
│ 当前会话标题 / 既有压缩操作与状态                  │ 新建会话            │
├──────────────────────────────────────────────────┤ 当前会话（选中）    │
│                         用户消息：靠右轻背景气泡  │ 其他会话标题        │
│ ▸ 思考过程（原折叠行为）                          │ 运行中的会话标识    │
│ 助手正文：Markdown 阅读排版                       │ 更多会话            │
│ 工具结果 / 本轮状态 / 失败与截断提示              │                     │
│                         消息区域独立纵向滚动      │ 列表独立滚动        │
├──────────────────────────────────────────────────┤                     │
│ 多行输入框                                       │                     │
│ [推理强度 · 高 ▾] [上下文占用环]        [提交按钮] │                     │
└──────────────────────────────────────────────────┴─────────────────────┘
```

只保留一个消息滚动祖先，输入框作为底部 `shrink-0` 区域，不使用 viewport 固定定位。正文和输入框共享中心对齐的阅读宽度：`width: 100%`、`max-width: 72rem`；内边距宽屏 20px、窄屏 12px。右栏使用当前工作台宽度与抽屉规则，不实现拖拽布局。

### 3.2 消息与输入框

- 用户消息右对齐、最大宽度 85%、8px 圆角、淡品牌色背景和细边；助手正文不套厚重大卡片。
- 思考仍由 `ThinkingBlock` 显示模型实际返回的文本；只把边框卡片弱化为紧凑 disclosure，不摘要、不改默认展开/折叠时机、不改用户选择优先级。
- 工具结果保留现有按需请求和文本展示，外观可弱化边框、压缩标题间距；不新增步骤聚合、伪进度、耗时或费用统计。
- 输入框采用一个圆角外壳，上方 textarea，下方左侧强度入口和上下文环，右侧原提交/结束操作。保留原 `rows=4` 与手动纵向调整，限制最大高度避免挤没消息区。
- 状态、错误、输出上限和变更路径在消息滚动区保持可见；禁用原因靠近输入框。不会为接近截图而删除现有状态事实。
- `AssistantMarkdown` 的解析、安全 URL、raw HTML 处理、GFM 与代码/表格横向滚动不变；仅调整 AI 范围内的排版。

### 3.3 强度滑块

- 原四档按索引映射：`0=off`、`1=low`、`2=high`、`3=max`；显示文案沿用“关闭/低/高/最高”。
- 采用 ThinkRail 同类外观：圆角轨道、从蓝到绿的已选渐变、浮动胶囊当前值、下方四个刻度、当前档说明；轨道 14px、交互容器 32px、胶囊 24px 高且最小 64px 宽。
- 用原生 `input[type=range]` 承担拖动、键盘、禁用、焦点和读屏；轨道和胶囊只是 `aria-hidden` 的装饰。左右端点预留半个胶囊宽度，保证 Off/Max 不溢出。
- 蓝/绿取 Manao `--info` / `--success`，胶囊、轨道、文字取现有语义 token。明亮主题同样可辨，不照搬截图黑底。
- 不添加截图刻度下的“默认值圆点”：ThinkRail 该圆点表示保存的默认偏好，Manao 没有对应设置；新会话 high 和历史下一轮档位仍使用原逻辑。
- 弹层复用已安装的 Base UI Popover；宽度 `min(360px, calc(100vw - 24px))`、优先向上左对齐，可自动避让。Escape/外部点击关闭并恢复焦点；AI 页隐藏、项目/会话切换或控件禁用时关闭弹层。

## 4. 全局约束与最小组件接点

1. 不改 `api/`、`contracts/`、后端、worker、数据库、模型参数和请求路径。`reasoningEffort` 仍作为原提交字段传输，不改8192输出上限。
2. 不改 `handleStart`、任务 UUID 持久化时机、丢响应对账、准入判断、写锁、关闭、压缩请求或历史分页算法。
3. 不改 `useAgentLiveOutput`、ACK 切割点、live→durable 合并、key、片段合并、错误恢复和重连逻辑。
4. 不把 `AgentConversationPanel`、`AgentTaskPanel` 或整棵聊天树移入 portal；只把会话列表放到右栏目标节点。
5. 非 AI 页的 Shell 布局、文件树、RunInsights 内容、查询及功能不变。允许的 Shell 修改仅为 AI 模式右栏接线、相应文案和焦点处理。
6. 新样式位于 `features/ai/AgentChat.css`，以 `.manao-ai-*` 限定；不改 `globals.css` 的全局 theme/token、通用 Button 或全局字体。
7. 不增加依赖、不复制 ThinkRail 后端与状态代码。ThinkRail 的 `--spacing=1px` 与 Manao 不同，不能原样复制 `h-32/p-8` 等 class。
8. pnpm；UTF-8 无 BOM；保留仓库换行规则。实现前重新读取将要修改的文件；不覆盖无关改动。
9. 本轮先完成计划。后续实现先做本地定向验证；不自动触发真实模型、镜像发布、集群变更、Git push/merge或资源删除。

### 展示接口

```tsx
// AgentTaskPanel.tsx：原业务 props 保留，只加展示信息。
type AgentTaskPresentation = {
  conversationHeader?: React.ReactNode;
  conversationHistory?: React.ReactNode;
  uiActive?: boolean; // 默认 true；只关闭隐藏页的弹层。
};

// AgentConversationPanel.tsx：控制器仍在原位置。
type AgentConversationPanelProps = AgentTaskPanelProps & {
  historyTarget?: HTMLElement | null;
};

// ConversationSidebar.tsx：不调用 API，不保存会话选择。
type ConversationSidebarProps = {
  items: readonly Pick<ConversationView, 'conversationId' | 'title' | 'activeTaskId'>[];
  selectedId: string | null;
  creating: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLoadMore: () => void;
};

// ReasoningEffortPicker.tsx：值只由原 AgentTaskPanel state 管理。
type ReasoningEffortPickerProps = {
  value: ReasoningEffort;
  disabled: boolean;
  active: boolean;
  onChange: (value: ReasoningEffort) => void;
};
```

不额外拆出业务 hook/store，不建立 sidebar registry，不抽象多 provider capability。两个 ReactNode 槽只服务现有会话内容和压缩工具条。

## Task 1：完成 AI 两栏布局与底部输入区

**Files:**
- Create: `poc4/frontend/src/features/ai/ConversationSidebar.tsx`
- Create: `poc4/frontend/src/features/ai/AgentChat.css`
- Modify: `poc4/frontend/src/features/ai/AgentConversationPanel.tsx`（原98–115行展示区）
- Modify: `poc4/frontend/src/features/ai/AgentTaskPanel.tsx`（props、264–384行展示区）
- Modify: `poc4/frontend/src/components/shell/WorkbenchShell.tsx`（右栏节点、AI props、163–204行焦点接线、614行开关文案）
- Modify: `poc4/frontend/src/components/shell/WorkbenchCommands.tsx`（右栏命令显示名称，仅增加可选文案参数）
- Test: 现有 `AgentConversationPanel.test.tsx`、`AgentTaskPanel.test.tsx`、`WorkbenchShell.test.tsx`

**Consumes:** 原 `conversations`、`selected`、`choose`、`create`、`list.fetchNextPage`、任务 props、Shell 的 `activePanel/insightsVisible/compactViewport`。

**Produces:** 上述展示槽与 `historyTarget`；保持原任务、会话和页签控制流程。

- [x] 先在原测试 fixture 上增加行为测试：右栏选择会话仍调用原切换；新建不启动模型；AI/编辑器来回切换保留输入和会话；隐藏右栏不丢选择；运行任务切换会话不关闭任务。保留原已有提交/压缩断言，不编写断言 class 名的样式测试。
- [x] 以定向命令运行新增行为用例，确认失败原因是新增布局接线尚不存在，记录 RED；原功能失败应先识别基线问题。
- [x] 将原 nav 抽成受控 `ConversationSidebar`，从原 handler 调用，不引入第二份选中状态或查询。错误提示仍使用原结果。
- [x] Shell 创建一个稳定的 AI 历史 aside/host；AI 启用时该 host 保持挂载，非 AI 或右栏关闭时设置 `hidden/inert`。非 AI 模式仍使用原 RunInsights props 和组件。不要把同一个 ref 同时赋给两个 sidebar。
- [x] `historyTarget === undefined` 时允许组件独立渲染原位置列表以兼容 standalone 测试；Shell 显式传 `null` 表示 host 尚未就绪，此时不重复渲染列表；节点就绪后只 portal nav：

```tsx
const sidebar = <ConversationSidebar
  items={conversations} selectedId={selected} creating={creating}
  hasMore={list.hasNextPage} loadingMore={list.isFetching}
  onSelect={choose} onCreate={() => void create()}
  onLoadMore={() => void list.fetchNextPage()}
/>;
const historyNavigation = historyTarget === undefined
  ? sidebar
  : historyTarget === null ? null : createPortal(sidebar, historyTarget);
```

- [x] 保持 AI tabpanel 原有持续挂载策略；仅改变 `uiActive`、右侧展示和工具提示。右栏开关/命令在 AI 时显示“对话历史”，其他模式保持“项目洞察”。
- [x] 焦点陷阱选择实际可见的右栏节点；依赖包含右栏模式。验证窄屏 Tab/Shift+Tab、Escape、焦点返回，以及从历史切回中间后的键盘可用性。历史 portal 位于中心面板之外，不能被中心抽屉遮罩的 inert 误伤；隐藏的 AI 右栏不可被 Tab 访问。
- [x] 通过 `conversationHeader/conversationHistory` 将原压缩工具条和 `ConversationHistory` JSX 交给 `AgentTaskPanel` 展示；移动原 form 到底部。保留所有 handler、条件、`key={selected ?? 'legacy'}` 和 ConversationHistory 原 key。

```tsx
// AgentTaskPanel 的目标结构；现有错误、状态、工具结果放在中间滚动区。
<section aria-label="AI task" className="manao-ai-chat">
  {conversationHeader}
  <div className="manao-ai-scroll">
    {conversationHistory}
    {/* 原错误、状态、legacy正文、结果和Changed paths展示 */}
  </div>
  <form onSubmit={handleStart} className="manao-ai-composer">
    {/* 原textarea与提交/结束控制；事件和禁用条件原样 */}
  </form>
</section>
```

```css
.manao-ai-chat { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
.manao-ai-scroll { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
.manao-ai-composer { flex-shrink: 0; margin: 8px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--lab-raised); }
.manao-ai-composer textarea { width: 100%; max-height: min(240px, 30dvh); background: transparent; }
```

- [x] 去掉 ConversationPanel 外层 `overflow-y-auto` 和包裹 TaskPanel 的 `min-h-64`；只保留上面一个消息滚动祖先。没有选中会话/加载失败时保持新建入口、错误提示及原禁用判断，不显示无依据的空闲成功状态。
- [x] 定向 GREEN：`pnpm exec vitest run src/features/ai/AgentConversationPanel.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/components/shell/WorkbenchShell.test.tsx --maxWorkers=4`。检查非 AI 页、`View run`、旧 task-only 展示未回归。

## Task 2：用四档滑块替换原 select

**Files:**
- Create: `poc4/frontend/src/features/ai/ReasoningEffortPicker.tsx`
- Create: `poc4/frontend/src/features/ai/ReasoningEffortPicker.test.tsx`
- Modify: `poc4/frontend/src/features/ai/AgentTaskPanel.tsx`、`AgentChat.css`
- Modify tests: `AgentTaskPanel.test.tsx`、`ContextUsageIndicator.test.tsx` 中实际依赖 select 的定位
- Modify: `poc4/frontend/tests/e2e/ai-output.spec.ts` 中 select 操作和选中值断言（仅适配 UI；不运行真实模型套件）

**Consumes:** 原 `reasoningEffort/setReasoningEffort`、原禁用条件和 `uiActive`。

**Produces:** `ReasoningEffortPicker(props)`；只输出原 `ReasoningEffort` 四个值。

- [x] 用 Testing Library 先写并运行四档回调、禁用、Escape/焦点返回、active=false 关闭弹层的测试；原生滑块方向键/拖动行为交给 Task4 的真实浏览器验证，避免依赖 jsdom 不完整的原生默认行为。现有提交测试改为操作 slider，但请求体断言不弱化。

```tsx
const user = userEvent.setup();
const onChange = vi.fn();
render(<ReasoningEffortPicker value="high" disabled={false} active onChange={onChange} />);
await user.click(screen.getByRole('button', { name: /推理强度/ }));
const slider = screen.getByRole('slider', { name: '推理强度' });
fireEvent.change(slider, { target: { value: '3' } });
expect(onChange).toHaveBeenCalledWith('max');
```

- [x] 使用已有 Base UI Popover 的 Root/Trigger/Portal/Positioner/Popup 组合，不新增全局 wrapper。受控 open 在 `!active || disabled` 时关闭，切会话沿用原 TaskPanel key。
- [x] 原生输入映射如下，刻度按钮统一调用 `onChange` 且同样受 disabled 约束；禁止填假 enum：

```tsx
const EFFORTS = ['off', 'low', 'high', 'max'] as const;
const LABELS = ['关闭', '低', '高', '最高'] as const;
const index = EFFORTS.indexOf(value);
<input type="range" min={0} max={3} step={1}
  value={index} disabled={disabled} aria-label="推理强度"
  aria-valuetext={LABELS[index]}
  onChange={event => {
    const next = EFFORTS[Number(event.currentTarget.value)];
    if (!disabled && next !== undefined) onChange(next);
  }}
/>
```

- [x] 按第3.3节设置装饰轨道、fill、胶囊和刻度；原生透明 thumb 与装饰胶囊使用相同宽度/位置范围。focus-visible 明确，disabled 降低强调但保持可读；动画遵循 reduced-motion。
- [x] 接回原表达式 `occupying || starting || submissionBlocked || admissionUnknown`。保留“轮询不覆盖未提交选择”、旧档位未记录、准入未知不可改的原测试。上下文占用环原组件和 usage 输入均保留在强度入口旁。
- [x] `ai-output.spec.ts` 的 high/off/low/max 操作改为先开弹层，聚焦 range 后按 Home，再按目标索引次数 ArrowRight，用 `aria-valuetext`/range value 断言，然后关闭弹层。不对 range 使用 `selectOption` 或文本 `fill`；不更改 wire/持久化/实时顺序断言。定位变更后做 `pnpm typecheck:stage6`，不能用 `--list` 声称真实 E2E 通过。
- [x] 定向 GREEN：`pnpm exec vitest run src/features/ai/ReasoningEffortPicker.test.tsx src/features/ai/AgentTaskPanel.test.tsx src/features/ai/ContextUsageIndicator.test.tsx --maxWorkers=4`。

## Task 3：对齐消息阅读排版与折叠外观

**Files:**
- Modify: `poc4/frontend/src/features/ai/ConversationHistory.tsx`（仅展示 JSX/classes）
- Modify: `poc4/frontend/src/features/ai/ThinkingBlock.tsx`（仅外观）
- Modify: `poc4/frontend/src/features/ai/AgentChat.css`
- Modify if needed: `poc4/frontend/src/features/ai/AssistantMarkdown.css`（只在现有 Markdown scope 内）
- Test existing: `ConversationHistory.test.tsx`、`ThinkingBlock.test.tsx`、`AssistantMarkdown.test.tsx`、`ToolResultView.test.tsx`

**Consumes:** 原 HistoryItem、live snapshot、Markdown、ThinkingBlock、ToolResultView；不新增消息投影类型。

**Produces:** 历史与实时回答共用的视觉类，行为仍由原实现负责。

- [x] 使用现有消息种类，用户消息增加右对齐气泡类，助手 text 保持 AssistantMarkdown；历史与 live 两条 JSX 渲染路径使用同组视觉类，不触碰 fragments/messages/correspondingSequence。
- [x] 思考使用紧凑标题、箭头与低强调文字；仍保留 details/summary、`choice/initialChoice/active` 与 `onChoice`，不因完成或切换样式覆盖用户选择。
- [x] Markdown 采用14px正文、约1.6–1.7行高、8–12px段间距；代码块/表格自身横向滚动，长路径可换行，不能让整个页面横向溢出。没有新增 Mermaid、公式、高亮依赖或 HTML 执行。
- [x] 只调整现有工具结果框和状态条外观，不新增工具分组和折叠状态机。未知状态仍显示未知，失败/截断/同步异常继续显式提示。
- [x] 运行既有回归：`pnpm exec vitest run src/features/ai/ConversationHistory.test.tsx src/features/ai/ThinkingBlock.test.tsx src/features/ai/AssistantMarkdown.test.tsx src/features/ai/ToolResultView.test.tsx --maxWorkers=4`。重点确认近底部才跟随、用户上翻不被拉回、live→durable 不重复且保持思考选择、安全 Markdown 与长片段。纯 CSS 修改不额外写快照测试。

## Task 4：完成浏览器视觉验收与交付记录

**Files:**
- Create: `poc4/frontend/playwright.ai-ui.config.ts`
- Create: `poc4/frontend/tests/visual/ai-ui.spec.ts`（与默认e2e发现路径分离）
- Create: `poc4/frontend/src/mocks/aiUiFixture.ts`（仅本地演示/浏览器测试 fixture）
- Modify: `poc4/frontend/src/mocks/browser.ts`（仅 fixture 启用接线）
- Modify: `poc4/frontend/tests/e2e/cloud-workbench-ui.spec.ts`（只有现有测试确需额外断言时）
- Modify: `poc4/frontend/README.md`、本计划、`AGENTS.md`；交付状态由 README 记录，本计划维护任务勾选。

**Consumes:** Tasks1–3 的真实 UI、现有 mock 登录/项目环境、现有 DTO。

**Produces:** 可复现的本地视觉证据和定向回归结果，不授予模型/云端/阶段四 PASS。

- [x] 不直接运行 `test:e2e:ai-output`：它依赖真实 cloud/model。当前 mock 默认会话列表为空，create/task 返回409，detail/history 返回404，不能拿这个空画面做视觉验收。
- [x] 增加小型 MSW fixture，复用现有类型：两个会话分两页、一份含标题/表格/长代码/思考/工具结果的固定历史、足够形成滚动的用户消息。仅匹配既有mock种子项目的实际ID，其他项目沿用默认handler。当前任务默认404，已完成 task 可读取；工具结果按既有DTO返回；新建会话只返回空会话并更新fixture列表，不启动任务。需要演示流式时使用固定有界 snapshot，不建立模型模拟器。
- [x] 在现有 `startMockWorker` 中，仅 `VITE_AI_UI_FIXTURE === 'true'` 时动态导入 fixture 并 `worker.use(...aiUiHandlers)`，随后执行原 `worker.start`。fixture 仍位于现有 mock-only 导入边界内；不暴露生产调试开关、不使用会被 MSW 截走的 Playwright page.route 来覆盖这些请求。
- [x] 专用 Playwright 配置设置 `testDir: './tests'`、`testMatch: ['visual/ai-ui.spec.ts', 'e2e/cloud-workbench-ui.spec.ts']`、单个Chromium项目和单worker；新UI测试放在visual目录，避免默认e2e在未启用fixture时误运行。webServer使用下述设置，避免Windows临时环境语法差异：

```ts
webServer: {
  command: 'pnpm build:mock && pnpm preview --host 127.0.0.1 --port 4173',
  url: 'http://127.0.0.1:4173',
  reuseExistingServer: false,
  env: { VITE_ENABLE_AI: 'true', VITE_AI_UI_FIXTURE: 'true' },
  timeout: 120_000,
},
use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
```

fixture 只负责展示足量内容；提交请求、不重复调用、会话权限和失联对账由既有定向单测验证，不能为截图构建第二套服务端状态机。

- [x] 浏览器至少覆盖1440×900、1024×768、390×844；默认深绿、graphite、light各检查一张宽屏画面，窄屏检查历史抽屉、滑块和输入框。截图保留最终代表图及必要失败证据。
- [x] 验收以下用户可见结果：
  - [x] AI 中心与右栏无四列挤压；文件树位置不变；非 AI 页右栏恢复原洞察。
  - [x] 长聊天滚动时输入框始终可见；页面不横向溢出；代码/表格局部滚动。
  - [x] 滑块可拖动、点刻度、键盘调节；四端值准确；禁用时不触发变化；弹层不被裁剪。
  - [x] 历史栏可切会话/新建/分页；隐藏后再打开不改变选中会话，不关闭运行任务。
  - [x] 窄屏抽屉可用Escape退出、焦点返回；AI页隐藏后没有残留弹层/可聚焦历史项。
  - [x] Markdown、思考折叠、上下文环、压缩与原任务状态没有缺失。
  - [x] 通过 `View run` 跳转时原 Run 视图和洞察恢复；不新增运行控制能力。
- [x] 依次执行下面命令。mock build 会覆盖 dist，所以**最后重新生产 build，再检查边界**：

```powershell
Set-Location D:/DeepLearning/MyProjects/Project_Manao/.worktree/ai-integration/poc4/frontend
pnpm exec vitest run src/features/ai src/components/shell/WorkbenchShell.test.tsx --maxWorkers=4
pnpm typecheck:stage6
pnpm exec playwright test --config playwright.ai-ui.config.ts
pnpm build
pnpm test:boundary
git diff --check
```

- [x] 检查最终 `dist` 不含 fixture 标识、mock路由/Service Worker；结合现有 browser boundary 检查记录实际结果。核对 diff 只涉及本计划允许文件；若需改业务 API、contract、stream reducer 或 global theme，先回到需求评估，不能随手纳入样式任务。
- [x] README 记录源提交、实际通过/失败数量、主题/视口截图、未覆盖事项；AGENTS仅补链接。不可把本地 fixture 结果写成真实 DeepSeek/云端/阶段二验收通过。
- [x] 删除本轮临时脚本、临时截图和无用构建日志；保留复现测试、最终截图和必要诊断。不得借此清理用户项目、历史或集群资源。

## 5. 主要风险与对应验证

| 风险 | 最小应对与证据 |
| --- | --- |
| 重排后自动滚动找错祖先 | 消息只一个纵向滚动区；保留现有滚动算法，浏览器检查长聊天与上翻 |
| 重挂载造成输入/折叠/流式丢失 | 保持 TaskPanel 与 History key、AI持续挂载；仅 portal 无状态列表 |
| AI隐藏后弹层残留 | uiActive控制UI open；测试切tab/抽屉/会话后焦点与弹层 |
| 右栏 focus trap 持有旧节点 | AI历史独立稳定ref，effect跟随可见右栏模式；窄屏Tab/Escape回归 |
| 滑块只是好看但改变请求或禁用 | 原四档映射、原disabled表达式、请求体和未知准入回归 |
| mock浏览器测试证明不了真实链路 | 明确本地证据边界，真实模型和部署不作为样式实现的隐含步骤 |

## 6. 本轮规划证据与参考

本轮已执行：只读核对两个工作树、阶段记录、当前前端组件/主题/测试、ThinkRail 展示代码，向用户确认两个布局决定；落盘本计划并检查文档。没有运行应用、模型、产品测试或部署。

Manao关键接点（行号是规划时参考，实施前重新定位）：
- `WorkbenchShell.tsx:934–1001`：AI持续挂载和RunInsights；`:129–204`：右栏偏好/抽屉/焦点。
- `AgentConversationPanel.tsx:98–115`：原列表、压缩、历史与TaskPanel组合。
- `AgentTaskPanel.tsx:170–254`：不可改的提交控制；`:271–315`：输入和强度；`:316–380`：状态/历史兼容展示。
- `ConversationHistory.tsx:58–65,105`：滚动跟随；`ThinkingBlock.tsx:2–8`：原折叠状态。
- `globals.css:60–85,253–325`：现有主题语义变量。

ThinkRail参考（只借视觉，不迁移控制层）：
- `apps/web/src/chat/Composer.tsx:564–705`：双行输入外壳。
- `apps/web/src/chat/ModelEffortPicker.tsx:159–302,487–541`：range装饰与弹层。
- `apps/web/src/chat/turns.tsx:197–207,240–267`：用户气泡和正文层级。
- `apps/web/src/chat/ActivityGroup.tsx:97–158`：紧凑disclosure外观。
- `apps/web/src/shell/layout/AuxiliaryPaneHeader.tsx:30–58`：侧栏标题条。
- `apps/web/src/styles/SPACING.md:45–56`：1px spacing，不能照搬utility。

已查官方文档的实现注意：React portal只改变DOM位置，目标节点变化会重建portal内容；Base UI现有Popover可承担定位/关闭/焦点；Playwright webServer.env可设置构建环境变量。实施以当前锁定版本和typecheck结果为准，不为示例升级包。参考地址：`https://react.dev/reference/react-dom/createPortal`、`https://base-ui.com/react/components/popover`、`https://playwright.dev/docs/test-webserver`。
