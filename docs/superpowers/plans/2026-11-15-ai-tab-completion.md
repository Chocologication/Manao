# Monaco AI Tab Completion Implementation Plan

> **For agentic workers:** 使用 `executing-plans` 按任务推进；只有另有明确授权时才使用 `subagent-driven-development`。步骤用 checkbox 跟踪。本文仅为规划，不是实施、调用模型或发布授权。

**Goal:** 用户在码瑙可写 Monaco 编辑器中停顿后看到 DeepSeek FIM 建议，按 Tab 接受，并继续使用既有撤销与保存流程。

**Architecture:** Monacopilot 1.2.12 负责编辑器交互，薄适配负责取消和有效性检查。现有 Java 后端增加一个经过既有鉴权与项目归属检查的 FIM 接口，使用平台统一配置的 Key/model；不接入 AgentTask，不新增服务或数据库状态。

**Tech Stack:** React 19、Monaco 0.55.1、Monacopilot 1.2.12、TypeScript、pnpm、Java 17、Spring Boot 3.5.9、JDK HttpClient、Jackson、Vitest、Playwright、JUnit。

**Spec:** [最小适配设计](../specs/2026-11-15-ai-tab-completion-design.md)，执行前与本文一起读取。

**Status:** 2026-11-15 已按用户后续明确授权实施 Task 1、Task 2 与 Task 3 本地范围。后端 22/22、前端 69/69、正式工作台固定响应 8/8、生产构建和边界 PASS；真实 Java + DeepSeek 与云端均 NOT_RUN，须独立授权。详见[分层验收](../../../poc4/docs/evidence/ai-tab-completion/acceptance.md)。以下“仅规划”表述保留编写时授权边界，以后续用户明确指令和本状态为准。

## Global Constraints

- 码瑙统一配置 DeepSeek Key 和补全模型，不使用个人聊天模型配置。
- 默认自动补全，不增加设置界面；`trigger: 'onIdle'`，沿用库的 400 ms 防抖；保留 follow-up。
- 首版只使用当前文件的未保存缓冲区；不抓取其他文件、聊天记录或项目索引。
- 不做用户限流、全局并发限制、配额、队列、自动重试、熔断或新缓存。
- 后端单次模型调用最多等待 5 秒；超时放弃本次建议，不弹窗、不影响输入；首版不设硬性延迟门槛。
- 已知 Python 多行换行/插入范围问题暂缓修复；继续允许多行建议；历史事实仍为 `FAILED`，本次修复要求为 `WAIVED_BY_USER`。
- 既有 `Canceled` 异常保留记录，仅在阻断补全或出现新增异常时调查；不全局屏蔽异常。
- 只在现有可写 Monaco 编辑面启用；沿用只读/写锁、model、dirty、撤销、revision 与保存合同。
- UTF-8 无 BOM；修改已有文件前重读；前端只用 pnpm。保留原有未跟踪探针和证据，不修改其历史结论。
- 不重跑无关阶段验收、不重置平台数据库、不增加 Kubernetes 资源或数据库迁移。

## 文件边界

以下路径均相对目标工作树根目录。新文件仅在后续获准实施时创建。

| 文件 | 责任 |
| --- | --- |
| `poc4/backend/src/main/java/com/manao/poc4/completion/CodeCompletionController.java` | 一个路由、项目归属校验、嵌套 Request/Response DTO |
| `poc4/backend/src/main/java/com/manao/poc4/completion/DeepSeekFimClient.java` | 一次 FIM HTTP 调用、5 秒截止、解析和固定错误映射 |
| `poc4/backend/src/main/java/com/manao/poc4/completion/CodeCompletionConfig.java` | 读取两个环境配置并创建复用 client；沿用 BackendAuthCondition |
| `poc4/frontend/src/api/codeCompletionApi.ts` | 两个文本字段与 HttpClient 调用 |
| `poc4/frontend/src/features/editor/tabCompletion.ts` | Monacopilot 注册、上下文检查、请求取消、清理 |
| `poc4/frontend/src/components/files/WritableMonacoEditor.tsx` | 挂载 editor 与一个生命周期 effect |
| `poc4/frontend/package.json`、`poc4/frontend/pnpm-lock.yaml` | 锁定 monacopilot 1.2.12，不升级已有依赖 |

测试与文档跟随下列任务。保持三个任务；不为配置、类型、脚手架或写 README 单独建任务。

## Task 1：提供最小 Java FIM 接口

**Files:** 创建上表的三个 Java 文件，以及：

- `poc4/backend/src/test/java/com/manao/poc4/completion/DeepSeekFimClientTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/completion/CodeCompletionControllerTest.java`
- `poc4/backend/src/test/java/com/manao/poc4/completion/CodeCompletionSecurityTest.java`

读取既有 `ProjectService.java`、`SecurityConfig.java`、`GlobalExceptionHandler.java` 和 `JwtAuthenticationFilterTest.java` 作为复用依据。无需修改这些生产文件。

**Interfaces:**

```java
// CodeCompletionController 的嵌套类型；引入 jakarta.validation.constraints。
record Request(@NotNull @Size(max = 16000) String prefix,
               @NotNull @Size(max = 16000) String suffix) {}
record Response(String completion) {}

// DeepSeekFimClient 的构造参数是具体依赖，不增加 provider 接口。
DeepSeekFimClient(HttpClient http, ObjectMapper json, URI endpoint,
                 String apiKey, String model, Duration requestTimeout)
String complete(String prefix, String suffix)

// Controller 接收 ProjectService 和具体 client。
Response complete(Authentication authentication, String projectId, Request request)
```

- [x] **1. 先写并运行失败合同测试。** 用本机 `com.sun.net.httpserver.HttpServer` 捕获上游请求，不访问真实 DeepSeek；Controller 用 Mockito 的 ProjectService/client 和 standalone MockMvc。安全测试复用现有 JWT filter + mock UserStore 的方式，真正经过生产 SecurityFilterChain，不以手工 principal 伪造未登录测试。下表每行均对应明确断言。

| 用例 | 断言 |
| --- | --- |
| 正常 FIM | POST `/beta/completions`；Bearer 为测试 Key；prompt/suffix 空白逐字一致；model、256/0/false 正确；返回 `choices[0].text` 原文 |
| 空前缀/空后缀 | DTO 接受空串，不误用 `@NotBlank`；缺字段/null 返回 422 |
| 超长任一字段 | 16,001 单位返回 422，client 没有被调用 |
| 空配置/空结果 | 缺 Key 不出网；空 choices、null、空字符串返回 null；应用配置可以正常创建 |
| 超时/故障 | 测试注入较短 timeout 并让假服务延迟；固定 503/502 错误；无原始响应、代码或 Key 泄漏；不应用层重试 |
| 未登录/非本人/不存在 | 分别 401/404/404；模型调用数为 0 |
| 非 READY | 返回 200/null；模型调用数为 0 |

例如上游协议测试的核心断言如下；`received` 为假服务将请求体解析后保存的 JsonNode，`client` 使用上面的构造签名创建：

```java
String prefix = "def add(a, b):\n    return ";
String suffix = "\n";
assertThat(client.complete(prefix, suffix)).isEqualTo("a + b\n");
assertThat(received.get("prompt").asText()).isEqualTo(prefix);
assertThat(received.get("suffix").asText()).isEqualTo(suffix);
assertThat(received.get("max_tokens").asInt()).isEqualTo(256);
assertThat(received.get("stream").asBoolean()).isFalse();
```

执行目录：目标工作树根。

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=DeepSeekFimClientTest,CodeCompletionControllerTest,CodeCompletionSecurityTest' test
```

预期先因待实现合同失败；不要把环境无法启动或零测试当作有效失败。

- [x] **2. 实现 client 与配置。** Config 受 `SecurityConfig.BackendAuthCondition` 约束，通过 `@Value("${MANAO_FIM_API_KEY:}")` 和 `@Value("${MANAO_FIM_MODEL:deepseek-flash}")` 读取配置。复用一个连接超时 2 秒的 JDK HttpClient；请求 timeout 固定 5 秒。构造生产 URI 为 `https://api.deepseek.com/beta/completions`，不跟随重定向，不增加 HTTP/LLM 依赖。

模型 payload 的最小实现形状：

```java
var body = Map.of(
    "model", model,
    "prompt", prefix,
    "suffix", suffix,
    "max_tokens", 256,
    "temperature", 0,
    "stream", false);
var request = HttpRequest.newBuilder(endpoint)
    .timeout(requestTimeout)
    .header("Authorization", "Bearer " + apiKey)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
    .build();
```

缺 Key 在出网前返回 null；读取 JSON 后只接受字符串 text，空结果返回 null。JSON/字段形态错误抛固定 `ApiException("AI_MODEL_PROTOCOL", 502, "Completion response invalid")`；超时、网络、非 2xx 抛固定 `ApiException("AI_MODEL_UNAVAILABLE", 503, "Completion unavailable")`。捕获 InterruptedException 后恢复 interrupt 标记；异常不携带供应商正文。只记录固定类别与耗时，成功调用无需保存正文或另建日志/指标框架。

- [x] **3. 实现 Controller。** `@RestController` + 同一 BackendAuthCondition；`@RequestMapping("/api/v1/projects/{projectId}/code-completions")` + `@PostMapping`。方法使用 Authentication、`@PathVariable`、`@Valid @RequestBody Request`。先查 owner，再查 READY，再调用 client。找不到本人项目用既有 `ENTRY_NOT_FOUND` 404；禁止通过调用文件内容接口间接校验、读取磁盘或获取项目锁。
- [x] **4. 重跑本任务三组测试。** 必须全部通过；测试不依赖 MySQL/Kubernetes 或付费模型，测试结束关闭假服务与其线程。若安全测试会创建数据库，改用现有 mock UserStore 模式，而不是新增数据库夹具。
- [x] **5. 检查 diff 并形成后端任务提交。** 建议提交信息 `feat(completion): add platform DeepSeek FIM endpoint`；只暂存本任务文件。

**交付：** 一个经过身份与项目归属验证、可被假上游独立测试的接口。此时编辑器功能仍未交付。

## Task 2：接入 Monacopilot 并约束请求生命周期

**Files:** 修改上表前端生产文件；创建：

- `poc4/frontend/src/api/codeCompletionApi.test.ts`
- `poc4/frontend/src/features/editor/tabCompletion.test.ts`

更新 `poc4/frontend/src/components/files/EditorWorkspace.test.tsx` 的 editor test double/模块 mock，使旧保存合同测试仍有效；不为了测试添加生产全局状态或浏览器调试接口。

**Interfaces:**

```ts
// codeCompletionApi.ts
export type FimContext = { prefix: string; suffix: string };
export type FimCompletion = { completion: string | null };
export function requestTabCompletion(
  projectId: string, context: FimContext, signal: AbortSignal,
): Promise<FimCompletion>;

// tabCompletion.ts；实现函数体，返回幂等清理函数。
export function registerTabCompletion(options: {
  monaco: typeof import('monaco-editor');
  editor: import('monaco-editor').editor.IStandaloneCodeEditor;
  projectId: string;
  path: string;
  language: string;
}): () => void;
```

- [x] **1. 写失败测试并运行。** API 测试使用项目既有 `setHttpClient(new HttpClient(...))` 和 fetch stub，断言相对路由、Bearer、两个字段及 signal。适配测试 mock `registerCompletion` 捕获 requestHandler，用可控 Promise 模拟旧响应晚到。按下表测试行为，不复制函数实现来“证明自身”。

| 场景 | 必须断言 |
| --- | --- |
| 未保存文本 | 发送的内容来自 model，而非初始 content prop 或已保存文件 |
| 防抖期间变化 | handler 收到旧 metadata 时不发送，光标相同但文本不同也不能误发 |
| 交错请求 | B 已发送后 A 完成，A 返回 null；A 的 finally 不清理 B |
| 内容/光标/选择区/焦点/model 变化与 Esc | signal 被 abort；即使传输忽略 abort，旧结果仍返回 null |
| 只读与卸载 | 不请求、不保留旧建议；deregister、timer、监听器均释放 |
| 项目/文件/语言切换 | 新注册身份正确；同前缀也不串项目；缓存显式关闭 |
| 空结果与网络/401/503 | 空建议；401 仍执行既有会话清理；输入与保存功能不受模型错误影响 |
| 长文本与空白 | 前后各 50 行/16,000 单位边界、前缀保留尾部/后缀保留头部；不 trim、不拆代理对 |

```powershell
pnpm -C poc4/frontend exec vitest run src/api/codeCompletionApi.test.ts src/features/editor/tabCompletion.test.ts
```

- [x] **2. 锁定依赖并实现 API 文件。**

```powershell
pnpm -C poc4/frontend add --save-exact monacopilot@1.2.12
```

```ts
// 函数体；getHttpClient 从同目录的 ./httpClient 导入。
return getHttpClient().request<FimCompletion>(
  `/api/v1/projects/${encodeURIComponent(projectId)}/code-completions`,
  { method: 'POST', body: context, signal },
);
```

不把整个 body.completionMetadata 透传后端；不修改全局 HttpClient 或 ApiErrorCode，沿用已有 AI_MODEL_* 错误码。

- [x] **3. 实现适配函数。** 注册的核心选项如下，检查条件使用实际 editor 状态，不只用 React 闭包中的旧 readOnly 值：

```ts
const registration = registerCompletion(monaco, editor, {
  language,
  filename: path,
  trigger: 'onIdle',
  maxContextLines: 100,
  enableCaching: false,
  allowFollowUpCompletions: true,
  triggerIf: () => !disposed && editor.hasTextFocus()
    && !editor.getOption(monaco.editor.EditorOption.readOnly)
    && editor.getSelection()?.isEmpty() === true,
  requestHandler: handleRequest,
});
```

`handleRequest` 在本模块实现，输入类型取 `NonNullable<RegisterCompletionOptions['requestHandler']>`，该类型从 `monacopilot` 导入；不要引用库未导出的内部文件。请求处理顺序：

1. 检查当前 model、光标与触发条件，metadata.cursorPosition 必须等于当前光标；当前光标前文本应以 metadata.textBeforeCursor 结尾，光标后文本应以 metadata.textAfterCursor 开头，否则立即 null。这里检查的是库生成的原始 metadata，之后才裁剪长度。
2. 取消旧请求，递增序号，捕获 model/URI/version/position，创建本次 AbortController 与 6 秒 timer；裁剪 prefix/suffix 后调用 `requestTabCompletion`。
3. 返回前再比较序号、signal、disposed、model/URI/version/position 和可写/焦点/选择区；失效返回 null。网络异常和 AbortError 都收敛为空建议；保留 HttpClient 的 401 副作用。
4. finally 清除本次 timer，仅在 controller 仍为当前请求时清空引用。

内容变化、光标/选择区变化、model/语言切换、失焦、Esc 和清理调用统一 `invalidate()`：递增序号并 abort。Esc 不拦截 Monaco 默认按键。只读/组件更新清理旧注册后，隐藏建议并注销 provider；使用官方 `editor.action.inlineSuggest.hide` 命令验证清理行为，不能靠隐藏 CSS。不复写库 formatter/range，不对多行做特殊处理。

在本模块定义 `syncRegistration()`，只负责一个活动注册：先注销旧 provider，比较 `toProjectModelUri(projectId, path)` 与实际 model.uri，并确认实际 model.getLanguageId() 等于传入 language；一致且可写才按上述选项注册，否则保持未注册。初始化和 model/语言事件调用它，事件调用前先使旧请求失效。组件 effect 在 props 身份变化时清理整个适配器并创建新的适配器；由此处理 React props 与 Monaco model 切换顺序不一致的窗口。不建立跨编辑器注册表。

- [x] **4. 挂到 WritableMonacoEditor。** onMount 将 editor 放入 state 触发 effect；保留现有 editorRef、revealTarget、Ctrl+S。effect 依赖 editor、projectId、path、language、readOnly，readonly 时立即清理，不销毁 model。不要改动 buffer registry、EditorWorkspace 写锁计算或保存 API。
- [x] **5. 运行定向回归与构建。**

```powershell
pnpm -C poc4/frontend exec vitest run src/api/codeCompletionApi.test.ts src/features/editor/tabCompletion.test.ts src/components/files/EditorWorkspace.test.tsx
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

确认生产 bundle 未引入 Node-only 执行代码、模型 Key 或参考仓库本机路径。失败先定位是不是新依赖/adapter 导致；不借机升级 Monaco 或重构其他编辑器。
- [x] **6. 检查 diff 并形成前端任务提交。** 建议 `feat(editor): integrate monacopilot tab completion`；只提交本任务文件和锁文件。

**交付：** 正式编辑器生命周期已接入、测试与构建通过；真实浏览器和真实模型状态仍需 Task 3。

## Task 3：在真实工作台中验证闭环并记录交付范围

**Files:**

- Create: `poc4/frontend/tests/e2e/ai-tab-completion.spec.ts`
- Modify: `poc4/frontend/src/mocks/handlers.ts`（仅增加 mock-only 固定响应，用于该浏览器用例）
- Create: `poc4/docs/evidence/ai-tab-completion/acceptance.md`
- Create: `poc4/docs/ai-tab-completion.md`（两个环境变量、行为、验收命令、已知限制）
- Modify: `poc4/docs/README.md`、`docs/what-we-have-done.md`（实现完成后才写当前状态）

**Interfaces:** 使用 Task 1 的路由和 Task 2 的实际编辑器；不创建第二套代理/浏览器演示页面。参考 `tests/e2e/stage3.spec.ts` 现有登录、文件创建、保存与重开流程，不扩建通用测试平台。

- [x] **1. 写正式工作台浏览器回归。** 增加的 MSW 路由默认返回 null，避免改变其他测试；仅合成上下文含 `__manao_tab_fixture__` 时返回固定候选，含 `__manao_tab_slow__` 时延迟 700 ms，含 `__manao_tab_error__` 时返回 503。这些分支只在 mocks 目录，禁止出现在生产功能模块。用实际登录、文件树和 Monaco 验证，不复用独立 browser-spike 页面作为通过依据。

固定返回内容以 Java/Python/TypeScript 的 `a + b` 短表达式为主，另加一个已知可拼接的多行样本。后续 follow-up 返回 null 即可，通过请求计数确认接受后仍发起请求。不得由测试调用 registration.trigger() 代替默认 onIdle 主流程。

**必须覆盖的用户行为：**

| 行为 | 断言 |
| --- | --- |
| 输入后停顿 | 自动出现灰字，发送内容含未保存修改 |
| Tab / Ctrl+Z | Tab 后得到预期完整文本，dirty；一次撤销恢复接受前文本 |
| Ctrl+S 与重开 | 从实际文件内容 API 读回接受文本，重开仍一致 |
| Esc | 已显示或在途的建议消失/作废，原文本不变 |
| 切文件/语言/项目 | 延迟响应不能出现在新编辑面；新的补全可正常触发 |
| 只读 | 已显示和在途建议均失效；恢复可写后重新工作 |
| 503 / 空补全 | 可继续输入、Tab 原有行为和保存；不出现模型错误弹窗 |
| 本地建议菜单 | 与 Monaco 既有建议菜单共存，无灰字时 Tab 仍可缩进 |

回归记录 `pageerror`，不得用 catch 全部吞掉。既有 Canceled 符合设计中的例外才单列；新增异常让用例失败。换行失败复用原证据，不新增一个永远失败的阻断测试。

- [x] **2. 运行定向浏览器检查并重建生产包。**

```powershell
pnpm -C poc4/frontend exec playwright test tests/e2e/ai-tab-completion.spec.ts --project=chromium
pnpm -C poc4/frontend build
pnpm -C poc4/frontend test:boundary
```

现有 playwright.config.ts 会启动 mock 构建；后两条检查最终生产构建，避免拿被 mock 覆盖的 dist 做交付。通过后不自动扩跑完整阶段矩阵。

- [ ] **3. 真实 Java + DeepSeek 联调。** 在另行授权执行与模型调用后，使用本次工作树构建、真实 Java 接口和工作台。仓库外加载 Key 到 `MANAO_FIM_API_KEY`，不将私人路径或 Key 固化进脚本。使用专用测试项目的合成 Java/Python/TypeScript 文件，各一次自动短补全 → Tab → 保存 → 重开；观察 follow-up、切文件与错误退化。记录触发到灰字的时间（含 400 ms）、接口耗时、接受文本、保存结果与实际模型名；不声称得到可靠 p95。

不要把上一轮临时 Node 代理接入本次链路。未运行标记 `NOT_RUN`，不能把固定响应 PASS 升格为真实模型 PASS；真实项目仅保存合成测试内容，沿用既有 disposable 资源和 owner 范围要求。

- [ ] **4. 云端交付与冒烟（独立发布授权后）。** 对同一候选构建增量更新已有 frontend/backend，不创建新服务/PVC；后端现有部署环境配置两个 FIM 变量。关闭本地 Vite/backend/隧道，通过已部署浏览器完成一次自动建议、Tab、保存重开和切文件；验证浏览器网络只连码瑙 API，Key 留在后端。记录构建/镜像身份、目标环境和结果；没有执行就明确云端 `NOT_RUN`，不声称目标已云端交付。移除 Key 可停用模型请求，完整回滚沿用已有前后端镜像回滚流程。

- [x] **5. 完成文档、范围自检与提交。** acceptance 按下表记录实际值，不以单一全绿结论掩盖例外；功能文档说明配置与行为，进度页只链接对应验收。保留旧的 `2026-11-15-validation.md` 及 JSON，不把历史失败重写成成功。建议提交信息 `test(completion): verify workbench tab completion flow`。

| 验收栏目 | 规划时状态 | 更新依据 |
| --- | --- | --- |
| 后端合同/鉴权 | NOT_RUN | Task 1 真实命令结果 |
| 前端生命周期/构建 | NOT_RUN | Task 2 真实命令结果 |
| 工作台固定响应交互 | NOT_RUN | Task 3 浏览器结果 |
| Java 后端 + 真实 DeepSeek | NOT_RUN | 本次实际联调，不能引用旧探针替代 |
| 云端交付 | NOT_RUN | 同一候选构建云端冒烟 |
| Python 换行缺陷 | 历史 FAILED；本次 WAIVED_BY_USER | 保留旧证据，未声称已修复 |
| 既有 Canceled | 根因未知；本次 NOT_REVERIFIED | 非阻断例外按用户确认记录，新增/阻断失败需处理 |

**交付：** 实际工作台闭环和明确分层的证据；云端项未运行时只报告已完成的本地范围。

## 计划自检结果

| 检查 | 结论 |
| --- | --- |
| 目标是否闭合 | 前后文 → FIM → 灰字 → Tab → dirty/Undo → 保存重开，对应 Task 1–3 |
| 是否绕过用户决策 | 无：统一 Key/model、默认开无设置、follow-up、无速率限制、5 秒与两项已知问题取舍一致 |
| 是否过度设计 | 无 Node 服务、fork、通用 provider、数据库表、设置页、RAG、缓存、监控平台、额外状态机或阶段门禁 |
| 测试是否有实际价值 | 协议、归属、过期响应和真实编辑行为；不为常量、文档或可逆低影响编辑单独造测试 |
| 符号与合同是否一致 | 路由、prefix/suffix、null、环境变量、5 秒/6 秒、deregister 在设计和三任务一致 |
| 现有测试是否受影响 | 已明确更新 editor mock，默认 MSW 空建议，并验证实际 Monaco 行为 |
| 是否夸大已知能力 | 历史探针/正式实现/真实模型/云端分开；未知延迟、Canceled 根因与已豁免换行均明确 |
| 是否还需用户决定 | 本轮三个低把握选择均已确认；后续新证据若导致范围变化再询问，不预设新架构 |

本次规划只做文档路径、相对链接、UTF-8 无 BOM 与 diff 检查，不执行上面列出的实现测试或清理既有证据。实施完成按任务范围清理本次测试产生且无需保留的临时进程/文件，不做广泛 git clean 或资源删除。
