# AI 对话工作台

范围：桌面主区域/右侧面板切换；同一会话手动选择聊天或任务；结果优先的工具摘要；自动应用或按文件审阅；个人 OpenAI 兼容模型；代码、文件、日志、图片、PDF、Word 附件。2026-11-12 的集群发布已完成局部真实验证，HTTP 入口的 UUID 兼容问题阻断了该次完整浏览器验收，见[原发布记录](evidence/assistant-studio/cloud-20261112.md)。2026-11-14 已发布最小修复，真实 HTTP 的配置弹窗和新建会话冒烟通过；本轮未验证真实模型聊天与任务审阅，见[修复发布与验证](evidence/assistant-studio/cloud-20261114-http-uuid.md)。

聊天由独立只读服务执行，服务端只开放目录、文件与日志读取。项目任务沿用 AgentTask 的占用、工具账本、Worker fencing 和收尾协议。新会话保存每轮 mode/model/applyPolicy，任务请求与幂等 ID 绑定。既有任务和会话 API 继续兼容。

审阅模式的 write_file 写入提案覆盖层，read_file 优先读取提案；开发构建将覆盖层放入隔离副本。原项目直到应用前均保持原状。逐块选择后检查 base revision、文件摘要和任务占用，使用既有 receipt 协议应用；未知写入结果保留原操作 ID，禁止盲目重试。提案验证与应用后验证分别记录。

默认审阅以文件为单位，展示文件名、增删行数和接受/拒绝操作，代码差异默认折叠。展开文件可查看 diff，再开启“按代码块审阅”可保留部分修改。按文件操作会选择该文件的全部 hunk，沿用原应用协议；按代码块审阅后也可以用文件操作覆盖此前选择。

模型 Key 以 AES-GCM 和用户/模型身份作为 AAD 加密；需要设置独立的 `MANAO_AI_CREDENTIAL_KEY`（32 bytes 的 Base64）。缺失时禁止保存真实 Key。地址采用 HTTPS，禁止凭据、查询参数、重定向及内网目标；本地假服务通过测试注入，不在产品地址规则中放宽。

附件按账号/项目隔离，限制文件大小及解析结果。图片按模型能力发送，PDF/Word 在服务端抽取文本。页面和模型不能选择跨账号资源，附件内容视为用户数据。

本地验收覆盖：后端权限与凭据、假模型流、只读工具、提案 hunk/冲突/幂等、Worker、前端与桌面浏览器流程、类型检查和生产边界。其历史 NOT_RUN 不代表当前云端状态；真实场景分别以[2026-11-12 记录](evidence/assistant-studio/cloud-20261112.md)和[2026-11-14 修复记录](evidence/assistant-studio/cloud-20261114-http-uuid.md)为准，不能将局部通过视为完整浏览器 PASS。

## HTTP UUID 兼容修复（2026-11-14）

模型设置、新建会话（按钮及首次发送）、消息和审阅应用的五处 ID 生成统一使用 `createUuid()`。HTTPS 下优先使用原生 `crypto.randomUUID()`；普通 HTTP 缺少该方法时，沿用已有模块的 `crypto.getRandomValues()` 算法生成标准 v4 UUID。请求持久化、幂等与重试规则保持原样。

本地结果：无模型时打开并保存配置的测试先复现 `crypto.randomUUID is not a function`，修复后相关单元测试 24/24 PASS；既有 Chromium mock 场景 11/11 PASS；新增的原生 API 可用/缺失两场景定向重跑 2/2 PASS，覆盖添加模型、首次发送隐式创建会话、手动新建会话、发送任务和审阅应用，并检查请求中的 UUID 与页面异常。缺失 API 由浏览器初始化脚本模拟，不代表真实公网或模型验收。

类型检查、启用 AI 且关闭 mock 的生产构建、浏览器边界检查（36 项脚本测试及生产包）PASS；本次修改涉及文件的 lint 为 0 error / 5 条已有 Hook warning。浏览器首轮因未启用 AI 无法找到入口；启用后，新增测试因两个同名“新建会话”按钮定位歧义失败，限定对话区域并等待会话切换后通过。上述执行问题不记为一次全绿。

从 `poc4/frontend` 复现：

```powershell
pnpm install --frozen-lockfile
pnpm test src/lib/uuid.test.ts src/features/ai/studio/ModelSettings.test.tsx src/features/ai/studio/api.test.ts src/features/ai/studio/ValidationResult.test.tsx
$env:VITE_ENABLE_AI = 'true'
pnpm exec playwright test tests/e2e/assistant-studio.spec.ts --project=chromium
$env:VITE_ENABLE_MOCK_API = 'false'
$env:VITE_ENABLE_STAGE0_PAGE = 'false'
pnpm build
pnpm test:boundary
```

后续经用户授权，仅更新 frontend 镜像完成集群发布，取得 `HTTP_UUID_BROWSER_SMOKE_PASS`。真实模型配置保存、聊天与任务审阅因当前账号没有个人模型而 NOT_RUN；精确镜像、回滚与实测范围见[发布记录](evidence/assistant-studio/cloud-20261114-http-uuid.md)。2026-11-12 的 `BROWSER_ACCEPTANCE_FAILED` 保留为原部署结论。

## 工作台中文文案

导航、文件操作、运行与终端状态、账户偏好、模型设置和相关弹窗使用中文。保留 AI、API、Java、Python 等技术名称，以及项目名称、文件名、代码、模型名称与日志原文。共用模板显示名称同步使用中文。

运行、终端命令和 AI 任务的协议状态保持原值，界面通过展示层映射为中文。Monaco 的简体中文资源在应用入口加载，先于编辑器模块注册菜单，覆盖右键菜单与查找栏。

界面使用常见产品术语，必要时补充操作说明：项目状态展示“已就绪”“项目异常”，统计项“异常 / 删除中”包含 FAILED 和 DELETING，悬浮说明统计范围；右侧面板使用“运行概况”，执行记录使用“运行日志”。项目概览、命令面板、偏好设置及登录介绍采用相同名称。

任务模式保留“审阅后应用 / 自动应用”。审阅模式说明“先生成变更方案，经审阅后应用到项目文件”；提交按钮为“应用所选变更”。验证结果分为“应用前验证”和“应用后验证”：前者在临时副本中执行，后者在变更写入项目后执行，二者不能互相替代。空运行记录中的“打开运行面板”只切换面板，不直接启动运行。

## 本地演示

在 `poc4/frontend` 目录运行：

```powershell
$env:VITE_ENABLE_AI = 'true'
pnpm dev:mock --host 127.0.0.1 --port 4183 --strictPort
```

打开 <http://127.0.0.1:4183/>，使用 mock 账号 `alice` / `demo-pass` 登录后进入项目列表，点击项目的“进入工作台”，再选择 **AI** 标签。可以体验流式聊天、主区域/右侧面板切换、任务执行、同文件逐块审阅，以及模型设置和附件入口。刷新页面会重置 mock 数据；此入口使用模拟响应，不会调用真实模型。

实现与测试结论见[2026-11-03 本地验收记录](evidence/assistant-studio/2026-11-03.md)、[2026-11-04 中文化验收记录](evidence/assistant-studio/2026-11-04.md)、[2026-11-05 兼容性检查](evidence/assistant-studio/2026-11-05-compatibility.md)及[2026-11-06 GitHub 反馈修复](evidence/assistant-studio/2026-11-06-review.md)。
