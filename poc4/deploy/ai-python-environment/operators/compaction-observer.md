# 临时自动压缩事件观察器

`compaction-observer.mjs` 只连接显式 loopback WebSocket，不启用 inspector、不建立端口转发、不调用模型。Node 24 原生 WebSocket，无第三方依赖；不进入 worker 构建或产品启动路径。

主操作者需先核对已授权 Pod UID/imageID、闲置状态及运行中 `dist/pi-session.js` 的真实 URL/行号，再短期开启 loopback inspector 和限定 Pod 的本机转发。选择生产 `session.subscribe((event) => { ... })` 内第一条可执行语句所在行；不能使用 TypeScript 源码行号代替部署 JavaScript 行号。

```powershell
node poc4/deploy/ai-python-environment/operators/compaction-observer.mjs `
  --ws-url 'ws://127.0.0.1:19229/<actual-inspector-id>' `
  --script-url 'file:///app/dist/pi-session.js' `
  --line '<verified-deployed-line>' `
  --project-label '<projectId>' --task-label '<taskId>' `
  --wait-seconds 1800
```

`--line` 为 1-based。URL 与行必须来自部署源码，不猜路径。`ARMED.boundLocations=0` 只表示已注册等待脚本，不表示已命中；真正证据是 `EVENT`。条件仅匹配 `compaction_start` / `compaction_end`。等待上限 1–1800 秒；单次 metadata 读取默认 1000ms，`--pause-timeout-ms` 可设 50–2000。Inspector 断点短暂暂停整个 Node isolate；本工具不承诺暂停期间其他请求继续，且不做人工 hold。

读取使用只读固定表达式和 `throwOnSideEffect`；不写 field、不调用目标方法、不改 usage、threshold、返回值或模型。原始事件、callFrames、exception、summary 和凭据不写日志。摘要仅在本机内存有界读取后计算 SHA256；输出只有事件类型、reason、aborted、hasResult、tokensBefore、estimatedTokensAfter、SHA256 与数值 usage 白名单。错误输出固定状态码，不输出底层错误正文或 WebSocket URL。

`projectLabel`、`taskLabel` 是操作者传入的日志标签。始终 `projectIdentityVerified=false`，不能据它证明项目归属。若 frame scope 可读 `taskId`，必须与标签相等才 `taskIdentityVerified=true`；不等则拒绝事件并恢复。不可见时 false，必须另与 owner API / durable 行核对，不冒称身份已证实。

`usageSource=compaction-provider-result` 指摘要 provider 的实际 usage，**不是**压缩前普通编程请求的 usage。`tokensBefore` 是原生 SDK 当时投影（最后真实普通 usage 加尚未测量尾部估算），不能混作累计计费。普通请求 usage 需从该 task 的原始 durable assistant message 白名单另行只读提取。

通过 `reason=threshold` 直接证明 SDK 阈值分支；`overflow` 只证明恢复，`manual` 还可能来自平台任务起始自动 `beforePrompt -> session.compact()`，不能单凭该值断定用户点击。结合该 task durable compaction 行的 `source_task_id=writer_id=taskId`、tokensBefore、摘要 SHA 和继续执行证据验收。`FINISHED` 且 exit 0 仅表示观察到一个有 result 且未 aborted 的 compaction_end；不会授予整个 AI 验收 PASS。

每次退出先尝试 `Debugger.resume`，再移除自己的断点、禁用本连接 debugger 并断开。异常、task 不匹配、等待超时、SIGINT/SIGTERM 都走同一清理；进程被强杀或端口断开时无法保证收到 resume ACK，操作者必须核对目标恢复及清除临时 inspector/forward。本工具只宜独占本轮 debugger，不能与另一调试器同时控制同一 isolate。

本地真实 child Node inspector 自测（不访问集群/模型）：

```powershell
node --test poc4/deploy/ai-python-environment/operators/compaction-observer.test.mjs
```

覆盖真实条件断点 start/end、任务身份不匹配、超时拆断点后目标响应、getter 读取异常仍恢复、非 loopback/凭据 URL 拒绝、秘密正文不输出和确定摘要 SHA。子进程与专用临时目录在自测结束后清理。
