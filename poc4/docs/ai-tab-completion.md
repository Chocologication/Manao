# AI Tab 补全

可写 Monaco 编辑器默认使用 Monacopilot 1.2.12，输入停顿约 400 ms 后自动请求建议。Tab 接受灰字，Esc 放弃；接受后继续使用现有脏状态、Undo 和 Ctrl+S / 保存按钮。保留接受后的 follow-up，没有新增设置页。

实现链路为浏览器 → 码瑙 Java API → DeepSeek FIM。当前验证与发布范围见[验收记录](evidence/ai-tab-completion/acceptance.md)，不能把本地固定响应验证视为真实模型或云端通过。

## 平台配置

| 后端环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MANAO_FIM_API_KEY` | 空 | 平台统一 Key；空时返回空建议，不影响启动 |
| `MANAO_FIM_MODEL` | `deepseek-flash` | 平台统一补全模型 |

凭据由后端运行环境注入，不写入仓库、前端环境变量或个人聊天模型配置。生产上游固定为 `https://api.deepseek.com/beta/completions`，不允许浏览器指定供应商地址。模型请求 `max_tokens=256`、`temperature=0`、`stream=false`，连接截止 2 秒，完整请求（包括正文读取）最多等待 5 秒，不做应用层重试。浏览器另有 6 秒取消计时器。

## 接口与上下文

`POST /api/v1/projects/{projectId}/code-completions`，沿用现有 Bearer JWT 与 owner 校验。

```json
{"prefix":"def add(a, b):\n    return ","suffix":"\n"}
```

```json
{"completion":"a + b"}
```

缺 Key、非 READY 项目或模型空结果为 `200 {"completion":null}`。未登录为 401；非本人或不存在项目为 `404 ENTRY_NOT_FOUND`；缺失/null/超长字段为 422。供应商网络、超时、非 2xx 为 `503 AI_MODEL_UNAVAILABLE`，JSON/字段形态异常为 `502 AI_MODEL_PROTOCOL`，响应不携带供应商原文或源码。前端将建议请求失败静默收敛为空建议；401 继续执行既有会话清理。

上下文只来自当前文件未保存的 Monaco 缓冲区，沿用库的 `maxContextLines: 100`（无 relatedFiles 时前后各最多 50 行），再保留 prefix 尾部和 suffix 头部各最多 16,000 UTF-16 单位，截断不拆代理对、不 trim。后端不读取文件或 revision，不获取项目写锁，不创建 AgentTask 或数据库记录。

缓存关闭。请求发送前检查库在防抖前捕获的 metadata，返回时检查实际 model 对象、URI、语言、版本、光标与注册代次。输入、选择区/光标、失焦、Esc、只读、切文件/项目/语言与卸载会使在途结果失效，并尽力取消 HTTP。只读、无焦点、非空选择区和身份尚未匹配的编辑器不发送请求。大文件的 PlainTextEditor 与只读审阅面不接入。

## 验证

从仓库根目录执行，Maven 需在 PATH；前端只用 pnpm。

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=DeepSeekFimClientTest,CodeCompletionControllerTest,CodeCompletionSecurityTest' test
pnpm -C poc4/frontend exec vitest run src/api/codeCompletionApi.test.ts src/features/editor/tabCompletion.test.ts src/components/files/EditorWorkspace.test.tsx
pnpm -C poc4/frontend exec playwright test tests/e2e/ai-tab-completion.spec.ts --project=chromium --workers=1
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

浏览器回归运行实际工作台与实际 Monaco/Monacopilot，使用 mock 构建中的合成固定响应。其他缓冲区默认空建议；fixture、延迟和失败分支仅存在于 mocks。回归后重新 build 生产包，避免把 mock dist 用于交付。真实 Java + DeepSeek 与云端发布按独立授权执行；回滚可移除后端 Key 停用请求，镜像回滚沿用既有前后端流程。

2026-11-15 已按后续授权完成[真实联调与云端发布](evidence/ai-tab-completion/2026-11-15-cloud.md)。真实环境复验使用 `pnpm -C poc4/frontend exec playwright test --config playwright.ai-tab-completion.config.ts`；通过私有环境输入 `MANAO_TAB_BASE_URL`、`MANAO_TAB_USERNAME`、`MANAO_TAB_PASSWORD`、`MANAO_TAB_PROJECT_ID` 和 `MANAO_TAB_PHASE`（`local` / `cloud`）。该配置不启动服务、不 mock、不自动重试，关闭 trace/录像/截图。source map 可用 `MANAO_TAB_SOURCE_MAP_ROOT` 指向同一候选镜像提取的 dist，证据输出使用 `MANAO_TAB_EVIDENCE_FILE`。

## 已知边界

- Python 多行换行/插入范围缺陷仍保留[历史 FAILED](evidence/ai-tab-completion/2026-11-15-validation.md)，本次修复为 `WAIVED_BY_USER`。多行建议继续启用，不保证每个候选可直接编译。
- 历史 `Canceled` 在正式工作台也可复现。测试保留原始栈，通过 source map 仅识别相同的 Monaco `async.js:300 → cancellation.js:45 → runOnChange.js:45`，以及历史已有的 `Delayer.cancel async.js:251 → WordHighlighter.dispose wordHighlighter.js:652` 路径；新增异常或功能阻断继续失败，生产错误处理没有被屏蔽。
- 浏览器取消不保证上游立即停算或停止计费；后端通过 5 秒截止收束等待。不增加限流、全局并发、配额或缓存，也不声明可靠 p95 或复杂代码质量。
