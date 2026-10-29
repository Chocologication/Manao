# 2026-10-27 收尾修复关键云端故障验证

状态：**KEY_CLOUD_FAULTS_VERIFIED**。本轮四类关键场景全部通过；这是有边界的专项验证，不代表完整云端 A–N 矩阵。范围为后续四步中的第三项；前两项跳过，第四阶段不启动。

- 基线：`codex/ai-integration@1d410cd`；沿用 2026-10-26 已发布的 backend / Worker / frontend 镜像，不发布新实现。
- 目标：`kubernetes-admin@learn` / `manao-stage6b`，复用独立项目 `caafbc12-9831-4ff7-a411-0eb0f1c7ef75`。
- 顺序：真实 provider 拒绝导致任务失败；owner 手动结束执行中任务；执行中 backend 重启；Worker 收据前丢失及真实 1800 秒期限关闭。
- 证据：任务/收据/关闭原因、Worker 身份和 slot、工具调用次数、期限前后持久状态、项目实际写入与资源快照。
- 隔离：不恢复原 Task `b3b32518-f0ed-411e-aa85-1ecef95fbdc5`；Stage2 保持 PAUSED / NOT_GRANTED；不运行 Stage4；不修改运行库状态或期限。
- 当前预检：三组件 Ready，镜像与昨日一致，三节点 Ready；只有原故障 Task 占用。
- Metrics API 不可用，容量通过节点 allocatable / requests 与 Pod 调度结果判断。

## 已执行结果

| 场景 | Task | 当前裁定 | 实际证据 |
| --- | --- | --- | --- |
| provider 失败 | `c81e6176-7ecc-4aff-839a-0188c58ab829` | PASS | 临时无效模型名触发真实 provider 拒绝；FAILED / AI_PROVIDER_ERROR，唯一报告与 Worker ACKED 的 ID/SHA256 一致；active_project=NULL，实际写入201 |
| owner 手动结束 | `5cc9c8fa-10f6-46e3-a199-f7c35cb90657` | PASS | 实际模型 RUNNING 时调用正式 close，HTTP200 / 63ms，FAILED / AI_CLOSED；晚到报告 CLOSING、Worker slot 清空，后续写入201 |
| backend 执行中重启 | `3bc37f04-0981-460c-8ed2-b97e1b60a1ab` | PASS | backend Pod UID 替换；同 Worker boot / epoch1 / request digest 继续并自动 COMPLETED，收据/ACK匹配；deadline 保持04:02:05.473Z，后续写入201 |
| Worker 收据前丢失 + 期限 | `2d736460-be22-40d7-abb9-73836d83a524` | PASS | 强制删除执行中 Worker Pod，新 boot 后旧Task404；期限前RUNNING并保留写锁，写入409；实际等待原1800s期限，后台在到期15.648s后自动FAILED / AI_TASK_BUDGET_EXCEEDED，receipt=NULL、active_project=NULL；current404、后续写入201，重复close200保持原预算原因 |

脱敏结构化证据：[任务/DB/Worker快照](cloud-faults-20261027-safe.json)。时间均为 UTC；期限 `04:03:44.978Z` 对应北京时间 **2026-10-27 12:03:44.978**。

## 浏览器与注入边界

- 通过真实账号密码登录公共入口，进入完整 Workbench。期限前 New file / New folder 均 disabled，Start task disabled，End task 可见可用，显示 RUNNING 和“工作区写入已锁定”。[浏览器快照](cloud-faults-browser-before-ai-20261027.json)。
- 到期后重新登录进入完整 Workbench，New file / New folder 和 Start task 均 enabled，End task 消失，页脚“工作区可编辑”。[到期后浏览器快照](cloud-faults-browser-after-20261027.json)。本轮任务由 owner Task API直接提交、未绑定会话；重新进入时AI历史显示旧会话COMPLETED，不能把该标签当作预算任务失败状态证据，预算裁定由同taskId的API/DB证明。
- provider 故障只覆盖无效模型名造成的真实请求失败；原 Secret 引用已恢复，模型密钥未改。
- 期限等待中第二次重启 backend，新 Pod `backend-5ff8446db-9mldk` / UID `fab1dce3-ee9c-4bfd-bb92-ceee6a39c98b` Ready；数据库调度继续、deadline 未变，旧 Worker boot 的缺失任务保持占用。[重启后快照](cloud-faults-after-second-backend-restart-20261027-safe.json)。
- 首次 `process.kill(1, SIGKILL)` 没有改变 boot，任务 `f17941b2…` 正常COMPLETED，明确标 NOT_EXERCISED；未把命令返回成功当成故障验证通过。随后以实际 Pod UID 替换及新 boot + 旧Task404证明注入。
- 本轮五次任务均未创建应用 Run；不证明 READY 应用保留、运行中副作用清理、ACK丢失/锁竞争完整矩阵。前三个场景的后续201是独立目录写入，不修改业务源码。
- 浏览器工具尝试中的加载/超时发生在验证读取环节，未重复提交模型任务；实际有效浏览器记录来自独立脚本的完整登录/工作台路径，exit0。
- 本轮不处理历史清理拒绝目录，不删除原项目或平台数据；不 push / merge。

## 期限和最终核对

- UTC创建 `03:33:44.978622`，固定deadline `04:03:44.978000`，微秒截断后的间隔1799.999378s；整个等待没有修改数据库时间、Task状态或deadline。最终保存81组快照（含收尾再读）。
- 期限前最后周期快照 `04:03:28.943Z` 仍RUNNING / locked；`04:03:49.804Z`仍未结算，`04:04:10.732Z`首次周期观测FAILED / unlocked。数据库持久更新为 `04:04:00.626383Z`，比deadline晚15.648383s，符合当前最高30s的对账退避，而非到期瞬间保证。
- 缺失结果从未补造成功收据，Worker新boot旧Task404保持到最终；没有重跑原模型/工具，没有应用Run或未决workspace_operation。
- [最终API/数据库/镜像快照](cloud-faults-final-20261027-safe.json)：所有本轮Task已终态且不占用项目，三组件Ready1/1，镜像digest不变，原模型Secret引用恢复。原故障Task仍RUNNING / deadline=NULL / receipt=NULL，未发owner close。
- 实际删除本轮4个空验证目录，逐个确认空目录、owner API DELETE200及最终tree不存在；最终workspace revision30。原`terminal-release-proof`目录、项目、PVC均保留；未执行项目/平台资源删除。
- 本轮未改生产源码，未重跑无关全套单元测试，未发布新镜像；有效验证为真实云端Task/Worker/DB/浏览器路径。Stage2仍PAUSED / NOT_GRANTED，Stage4 NOT_STARTED。
- 文档链接、JSON、UTF-8无BOM、已知凭据泄漏检查及`git diff --check`通过。[产物核对结果](cloud-faults-artifact-check-20261027.json)。
- 本轮临时目录`.superpowers/cloud-faults-20261027/`的精确删除请求被自动审批拒绝（blocked by policy），实际本地删除0，9个文件保留；没有换工具、缩小删除或重试绕过。它们均是本轮验证脚本和原夹具快照，后续清理待单独处理。云端4个验证目录已按前述API确认删除，两类清理结果不可混用。
