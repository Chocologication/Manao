# AI Tab 补全实施与验收（2026-11-15）

已完成 Monacopilot 1.2.12 → Java FIM API 的正式代码接入，本地固定响应工作台闭环 `PASS`。真实 Java + DeepSeek 联调及云端发布/验收均为 `NOT_RUN`：本次授权实施，计划要求这两项另行授权。旧探针与真实模型调用结果未作为本次验收。

分支：`codex/ai-tab-completion`；规划基线：`c9ceb1b883d08747b8ccbf5c62f10de5702fc960`。Task 1：`ca35111`；Task 2：`07cd1b5`。Task 3 的测试、证据与文档跟随本记录所在提交。[使用与配置](../../ai-tab-completion.md)、[设计](../../../../docs/superpowers/specs/2026-11-15-ai-tab-completion-design.md)、[计划](../../../../docs/superpowers/plans/2026-11-15-ai-tab-completion.md)。

## 分层结果

| 范围 | 结果 | 本次证据 |
| --- | --- | --- |
| Java 协议、归属、JWT 鉴权 | PASS | 22 tests，0 failures/errors/skipped；本机 HttpServer + 生产 SecurityFilterChain，无数据库或集群 |
| API、前端生命周期与原保存回归 | PASS | Vitest 69/69；API 2 + adapter 19 + EditorWorkspace 48 |
| 实际工作台固定响应浏览器 | PASS | Chromium 8/8，0 unexpected/flaky/skipped；标准 Playwright 配置重建 mock 包，约 143 秒含构建/服务启动 |
| 生产包最终重建与边界 | PASS | pnpm build（typecheck + Vite）成功；boundary 36/36 + 实际 dist 检查成功；保留既有大 chunk 提示 |
| 本次真实 Java + DeepSeek | NOT_RUN | 未加载真实 Key、未发起模型调用 |
| 本次云端发布及验收 | NOT_RUN | 未构建/发布镜像，未修改集群；没有云端交付声明 |
| Python 多行换行修复 | WAIVED_BY_USER | [历史 FAILED 保留](2026-11-15-validation.md)，未修复、未禁用多行建议 |
| 页面异常为零 | FAILED | 本轮两条既有 Canceled；功能断言通过不改变这一结果 |
| Canceled 根因与修复 | NOT_REVERIFIED | 仅确认与历史相同路径且非阻断，不调查根因或修改生产错误处理 |

[浏览器原始分类与计时摘要](2026-11-15-workbench-results.json)保留全部八场景、原始异常栈及 source map 路径。用例耗时不是模型延迟，不给出真实模型 p95。真实模型名配置默认 `deepseek-flash`；本次没有实际调用来确认供应商响应模型。

## 实际工作台行为

- Java、Python、TypeScript：真实登录、文件树新建/打开；键盘输入后停顿自动出灰字，确认请求含未保存文本；Tab 得到预期文本且 dirty，follow-up 确实发起请求；一次 Undo 恢复接受前文本；重新自动触发并接受后 Ctrl+S，API 回读与关闭重开一致。
- Esc：显示中建议及 700 ms 在途建议均失效，未接受的文本不改变。503 与空建议时输入、Tab 缩进、保存可用。
- 切 Python → TypeScript 文件时晚到结果不进入新文件；实际 Monaco readOnly 切换会清除显示中和在途建议，恢复后自动补全仍工作。读写状态通过真实 editor.updateOptions 切换，React props/model 先后顺序另由 adapter 定向测试覆盖。
- 不同项目使用同一 prefix 仍发送新的 owner/project 作用域请求；新 model 不出现旧建议。注销时在途建议被取消，登录页没有残留。
- 一个可正确拼接的多行样本能接受；TypeScript 本地建议菜单可正常打开，无灰字时 Tab 可缩进。未将已豁免的 Python 多行失败伪装为通过。

主流程没有调用 registration.trigger 或 inlineSuggest.trigger。Monaco 原生 EditContext 是零尺寸焦点目标，测试等待编辑器可见及输入目标 attached；灰字按真实语法高亮的多个 span 合并断言。Windows model 可为 CRLF，断言仅统一 EOL，接口与生产代码不 trim 或改写空白。

## TDD、实现调整与失败记录

后端测试先因待实现类缺失失败，随后补实现并验证。第一次 Controller 夹具使用普通 Principal，与生产签名 Authentication 不匹配，修正夹具后通过；安全用例一直真实经过 JWT filter 与生产安全链，复用现有 mock JdbcTemplate 提供账号状态，不创建数据库。

前端 API/adapter 测试先因待实现模块缺失失败，随后实现。生产构建第一次发现测试中的普通位置对象不满足 Monaco Position 类型，修正夹具后通过。pnpm 增加依赖时重算的无关可选 peer 绑定已恢复，锁文件只新增 monacopilot/core 两包，冻结安装通过，未升级现有依赖。

浏览器早期轮次先后暴露测试沿用英文名称、原生 EditContext 零尺寸可见性、CRLF 和灰字多 span 断言问题，修正的是测试。八场景功能断言通过后，两个用例因既有 `Canceled` 使整轮 `FAILED`；source map 核对为历史 `async.js:300 → cancellation.js:45 → runOnChange.js:45`，最终只对这条同类路径单列，其他异常仍失败，原始栈保留在 JSON。

相比规划的必要细节调整：使用 sendAsync 的完整响应 future 截止约束正文读取；测试覆盖先发 headers 后正文停滞。adapter 为每次 provider 注册捕获代次，防止已注销 provider 的延迟 handler 在同一 model/语言恢复后重新请求。未新增服务、通用 provider、数据库状态、RAG、限流、缓存或库 fork。

## 复验与后续

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=DeepSeekFimClientTest,CodeCompletionControllerTest,CodeCompletionSecurityTest' test
pnpm -C poc4/frontend exec vitest run src/api/codeCompletionApi.test.ts src/features/editor/tabCompletion.test.ts src/components/files/EditorWorkspace.test.tsx
pnpm -C poc4/frontend exec playwright test tests/e2e/ai-tab-completion.spec.ts --project=chromium --workers=1
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

本机 Maven 不在 PATH，本次使用已安装的 IntelliJ bundled Maven 3，未安装或修改全局工具。验证时仅运行本地假上游与 mock 工作台，不重跑无关阶段矩阵、不创建运行资源。

下一步需独立授权：仓库外注入平台 FIM Key，在真实 Java 工作台对专用合成 Java/Python/TypeScript 文件分别执行自动短补全 → Tab → 保存重开；之后按独立发布授权，对同一候选构建增量更新已有前后端并关闭本地开发服务，完成云端浏览器冒烟。没有运行就继续保留 `NOT_RUN`。

原有九份探针、JSON 与 `2026-11-15-validation.md` 的收尾 SHA-256 核对一致，保持未跟踪且未纳入本次提交；证据目录仅提交本次新建的 acceptance 与 workbench-results。测试进程均已退出，4173/4174 无监听。

清理 `poc4/frontend/.ai-tab-local.config.ts`、`.ai-tab-results.json` 与 `test-results/` 时，批量命令及缩小后的逐文件/空目录删除均被自动审批审查拒绝，仅返回 `blocked by policy`，未给出更具体原因。两个删除命令均未启动，实际删除 0 项。残留为临时配置、原始 JSON 报告、test-results/.last-run.json 和八个空场景目录（含 test-results 根目录共九个目录）；配置与原始报告未暂存/提交。必要的两条异常栈与最终结果已保存在本专题 JSON 中；未绕过策略、未 git clean、未删除 worktree。
