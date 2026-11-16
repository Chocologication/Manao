# 运行结果分享验收

日期：2026-11-16。分支：`codex/run-result-sharing-plan`。Task 1–5 独立审查 PASS，最终整分支审查 **READY，零未关闭发现**。Task 5 第三轮真实闭环 **PASS：1 passed / 2.1m**，产品快照为 `5903eb5`；后续标题默认值修正 `f7b8227` 的相关12项与构建 PASS，真实 E2E **NOT_RERUN**。第一轮 FAILED / INTERRUPTED 和第二轮 FAILED 保留。云端部署及运行库迁移 **NOT_RUN**，默认 Vert.x transport 未修复。不授予整个平台重新验收通过。

## 源码与已经执行的验证

| 范围 | 源码身份 | 实际结果 |
| --- | --- | --- |
| Task 1 加法迁移、独立存储、旧数据兼容 | `0c8e642` | MySQL 三个目标类共 6 tests，0 failures/errors/skipped，PASS |
| Task 2 资格、原样快照、摘要和幂等竞态 | `f367a97c676b72afe535487b8f3fce5040ecdd28` | Service 27 + Store 4，共 31 tests，0 failures/errors/skipped，PASS |
| Task 3 HTTP、安全链、生命周期、维护与 JWT 回归 | `312ef6b1b83a9b086d2da226ca82872131de9aa1` | 44 tests，0 failures/errors/skipped，PASS；21:14:21 +08:00 |
| Task 3 cursor MySQL 时间边界修正 | `f8075ef4f688ecbb253d7cc7730d7c6360062cdc` | 相关 6 tests，0 failures/errors/skipped，PASS；21:22:05 +08:00；未机械重跑前述 44 项 |
| Task 4 前端目标回归、5 MiB 展示、构建与手机宽度 | `5903eb549e7f24e9c0cca6bcaf3eaeb7f7a90417` | 7 files / 100 tests PASS，build PASS；390px 手机 fixture 与 Chromium 5,242,880 字符原样展示 PASS，非真实后端证据 |
| Task 5 专用 runner 类型检查 | 基于 Task 3 + Task 4 工作区 | 定向 TypeScript 检查 PASS；仅证明 runner 编译 |
| Task 5 真实服务闭环、入口直开/刷新 | 产品 `5903eb549e7f24e9c0cca6bcaf3eaeb7f7a90417`；runner blob `b794988f79a71eb69c665a811cdae9fa404fb9b4` | 第三轮 1 passed / 2.1m，exit0；前两轮失败不改写 |
| 最终 P3 标题预填修正 | `f7b822755e988fec75fa085217a6dc794401cc6c` | 默认“运行结果”的组件→HTTP回归 RED1 → dialog12 PASS，build PASS；定点复审 PASS |
| 云端部署、运行库迁移 | 未执行 | NOT_RUN |

后端测试均使用 `JdbcStoreTestSupport` 创建/迁移/删除的 UUID disposable schema；未重置 `manao_poc4` / `manao_poc4_6b`。上述 selector 有重叠，不相加为独立用例总数。必要的可审查证据归档在[安全执行收据](verification-2026-11-16.json)，本页保留源码身份、命令和实际输出数量；不能将单元/组件结果当成真实 E2E。

最终整分支审查覆盖事务/删除竞态、快照与生命周期、HTTP权限、前端不确定提交/会话隔离及证据边界，仅发现标题未按设计预填的 P3。`f7b8227` 只改表单初始标题并补交互回归；复审确认 P3 ADDRESSED、没有新发现。真实 runner 明确 `.fill(title)` 覆盖输入，因此旧自定义标题闭环的适用范围保持；不能把旧 E2E 宣称为修正后 HEAD 重跑。Task 5 独立规格/质量审查 PASS / APPROVE，未发现需修改的 P1–P3 问题。

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=RunShareUpgradeMigrationTest,JdbcRunShareStoreTest,StudioUpgradeMigrationTest' test
mvn -f poc4/backend/pom.xml '-Dtest=RunShareServiceTest,JdbcRunShareStoreTest' test
mvn -f poc4/backend/pom.xml '-Dtest=RunShareHttpContractTest,RunShareLifecycleTest,RunShareServiceTest,RuntimeMaintenanceLoopTest,JwtAuthenticationFilterTest' test
mvn -f poc4/backend/pom.xml '-Dtest=RunShareHttpContractTest#cursorInstantsOutsideMysqlDatetimeRangeReturnValidationError+cursorMysqlDatetimeBoundsRemainValid,RunShareLifecycleTest#paginationUsesStableTiesOwnerScopeMaxLimitAndImmutableSummaryItems' test
```

## 验收矩阵

| 验收项 | 已有证据及边界 | 状态 |
| --- | --- | --- |
| 资格 | 八种状态全部覆盖；四终态可分享；其他活跃 Run 不阻止历史终态 | PASS（真实 MySQL service） |
| 内容 | 当前保留 chunks 原样拼接，空日志合法，摘要变化拒绝；不添加完整/截断提示 | PASS（service/HTTP/前端组件） |
| 大内容 | 含控制字符/多字节的 5,242,614 UTF-8 bytes 经 JDBC → 独立存储 → HTTP JSON 完整相等；Chromium 5,242,880 字符单文本节点滚动展示 | PASS（HTTP + 前端 fixture）；非同一次真实应用大内容闭环 |
| 唯一与重试 | 每 Run 单 ACTIVE、同键同结果、并发唯一键冲突事务外对账、失效旧请求不复活 | PASS（真实 MySQL service/lifecycle） |
| 独立性 | 源日志清理、真实 WorkspaceJdbcStore.deleteProject、service 重建后快照保持；真实浏览器在源项目404后重新请求仍逐字一致 | PASS（MySQL lifecycle + 真实浏览器）；重建服务由前者证明 |
| 生命周期 | 固定 72h、边界即时拒读、两小时 fixedDelay、到期清正文、撤销同步清正文并保留收据 | PASS（HTTP/lifecycle/maintenance）；未等待 72h 或真实两小时调度 |
| 权限与展示 | 匿名 GET、owner 权限、公开字段白名单、真实安全链 no-store、opaque error；HTML 文本/空/null/到期与 token 切换；真实匿名 context 无 bearer | PASS（后端/前端组件 + 真实匿名访问） |
| 真实闭环 | 登录生成 → 匿名看 → 源项目 404 后仍原样看 → 账户 UI 撤销 → 匿名 410 | PASS（第三轮真实服务） |
| 入口路径 | 本地真实站点直接打开/刷新 `/shares/:token`，public API 与 UI 链接同 origin；二维码相同 URL 由组件/手机 fixture 核对 | PASS（本地站点）；云端入口 NOT_RUN |

## 真实服务执行与精确清理

准备路径为 fresh disposable schema + 本地当前源码后端/前端 + 真实 Kubernetes namespace `manao-stage6-test`。账号仅在 fresh schema 内建立，不访问原云用户数据；环境准备完成不能替代业务验收。

本次本地站点使用官方同版本 Fabric8 Jetty 7.7.0 的 **runtime-only classpath**，保留远端 HTTPS/CA/hostname 校验。默认 Vert.x provider 不支持该 public kubeconfig 的 tls-server-name，真实 readiness 失败；未修改产品 pom/lock/source，不能宣称默认 transport 已修复或已验证生产部署。

第一轮 invocation `cd3affec-b8f7-4fa0-b7f3-08e8cc892056` 创建唯一项目 `900ed23e-3b9b-4052-b95a-e52fee3c3205`，未创建 Run/分享。runner 在 READY 后硬导航导致仅内存登录状态丢失，进入 `/login` 而非工作台；只读浏览器复现与 AuthSession 源码已确认，属于 fixture 导航缺陷。随后 finally 进入精确删除；测试环境原 `nfs-storage` 的 archiveOnDelete=true 触发已有 cleaner 的 STORAGE_POLICY_UNVERIFIED，保留该项目 DELETING 与唯一 Bound PVC/PV。协调者要求中断该 runner，exit1；原主断言没有及时落盘，不能伪造其精确 failure 文本。已修 fixture 的 SPA 导航、catch/finally 即时安全记账和删除错误快速终止，待精确残留闭合后再运行新 invocation。

第一轮随后按独立审查批准的 exact project/PVC UID/NFS leaf 归属完成定点处置，不改共享 StorageClass；同 owner 续作一次 DELETE204 → GET404。独立 DB 源行与关联行均为0，project label 下 Pod/Service/Job/PVC为0，原 PV/helper404，原/指定 archive leaf 不存在。第二轮改用已有 `manao-poc4-delete` 的 runtime-only 配置。

第二轮 invocation `9ebe387c-eb0a-4950-9c5f-86025dcf0df0`，project `e42d7891-86e3-4e70-9ec1-eeb03c7d6f97`、Run `af7c6bff-e6d3-40b5-9b29-0ad5fcd13b5d`，测试32.3s失败，未创建分享。精确 Pod Event 记录 `exec /usr/local/bin/manao-maven: no such file or directory`，随后 Job `BackoffLimitExceeded`；旧6A Maven镜像与当前 Job 合同不匹配，未发现调度/挂载失败证据。runner 原 catch 仅保留 matcher/source 位置、吞掉实际状态，因此不能事后伪造 exact Run.state/exitCode；现已增加实时 Run facts、安全 expected/actual 及清理前日志诊断。finally DELETE204→GET404，独立源行0、精确labels0、PV404；没有另造 NFS 目录直接核验结论。

第三轮使用既有6B Maven镜像（先由一次临时 Pod 验证 `/usr/local/bin/manao-maven` 可执行、退出0并删除 probe 到404）和既有删除型 StorageClass；均只覆盖本次 owned backend 环境，不修改共享 class 或产品源码。当前产品源码、Jetty严格TLS、fresh schema/owner保持一致。

第三轮 invocation `de5179fb-2564-4411-8568-b29617ef9eea`：project `734d9075-df5b-4c80-8cee-918ab2be925b`，Run `6503e985-5927-497a-8743-43f6d2f95b2b` 为 SUCCEEDED / exitCode0 / BUILD_SUCCEEDED；UI创建 share `5e24a1aa-aa79-4ed9-b2d4-242b535a22c8`，到期 `2026-11-19T14:20:59.092376Z`，创建/到期差精确72h。

权威 preview 日志为 **151 UTF-8 bytes**，SHA-256 `bfc20df8b34dab82aedfac7cdba2c4b3f5d46dd1710d115cd1e7dbbbe71e68ad`。匿名独立 context 直开返回200，正文 textContent 与原文逐字相等；源项目删除后GET404，再匿名刷新返回200，整个公开DTO相同，正文仍为同一151 bytes/摘要。最后通过账户“我的分享”的精确 share ID 行撤销，匿名刷新410 / RUN_SHARE_REVOKED，旧正文不再显示。公开读取不携 bearer，200响应 no-store。源DELETE响应未确认为204，但有限GET对账确认404，未盲目重放。

```powershell
pnpm --dir poc4/frontend exec playwright test --config playwright.run-sharing.config.ts
```

必须显式私密注入 `MANAO_BASE_URL`、`MANAO_RUN_SHARE_USERNAME`、`MANAO_RUN_SHARE_PASSWORD`；无默认账号/站点，不启动 mock，单 worker、零重试。账本写入 `poc4/frontend/test-results/run-sharing/` 的本次 invocation 子目录；仅保存非秘密 ID 和日志 SHA-256/UTF-8 字节数。生成/撤销必须 UI，原文比较保留换行，不能只断言页面存在。

Task4 已执行的命令及 Task5 runner 定向检查如下；已通过且没有相关修改的目标未机械重跑。手机与5MiB浏览器样本使用实际组件及HTTP fixture，只证明展示/布局，真实151-byte应用闭环由第三轮证明。

```powershell
pnpm --dir poc4/frontend exec vitest run src/contracts/runShare.test.ts src/api/runShareApi.test.ts src/features/shares src/components/runs/RunPanel.test.tsx src/components/shell/AccountPanel.test.tsx --reporter=dot
pnpm --dir poc4/frontend exec vitest run src/features/shares/RunShareDialog.test.tsx --reporter=dot
pnpm --dir poc4/frontend build
pnpm --dir poc4/frontend exec tsc --noEmit --target es2023 --module esnext --moduleResolution bundler --skipLibCheck --strict --noUnusedLocals --types node playwright.run-sharing.config.ts tests/e2e/run-sharing.spec.ts
```

| 清理对象 | 当前结果 |
| --- | --- |
| 本次专属项目 API 404 | PASS（第三轮 runner 真实对账） |
| 同 project label 下 Pod/Job/Service/PVC；适用 PV | PASS：runner及独立精确labels0，事前记账PV404/无claimRef，原/指定archive NFS leaf实核不存在，只读helper404 |
| fresh schema 内本次 project/run/log 关联行 | PASS：独立JDBC project/operation/storage_binding/run/ticket/session/audit全部0、exactRun chunks0 |
| 本次 share 的撤销与正文清空、收据保留 | PASS：UI撤销204/匿名410，独立DB同owner/source/run/request，REVOKED、三正文列NULL，收据保留；token仅核对长度未输出值 |
| 本地测试站点关闭、fresh schema 清理 | PASS：仅本次owned进程核对启动时间/命令后停止，18090/4174无监听；仅本次fresh schema DROPPED，information_schema计数0 |

运行资源收尾于 `2026-11-16T14:46:46.7557734Z` 完成：drop前再次核对源project/run0、三项目集群零残留/helper不存在、已撤销分享正文NULL且收据保留。随后仅删除本次 disposable schema；这会一并删除其测试分享收据，不能误读为产品回收策略删行。平台运行库未触及，用户隧道和其他服务保留。精确runtime scratch删除27文件/145,755 bytes，临时Vite配置删除1文件/331 bytes，共 **28文件/146,086 bytes**。安全执行与审查摘要已进入仓库收据，不依赖ignored诊断路径。

剩余本地临时文件清理未完成：自动审批审查拒绝删除本计划的 `.superpowers/sdd/2026-11-16-run-result-sharing/` 和 `poc4/frontend/test-results/run-sharing/`，返回 `blocked by policy`。已预检两目录均位于当前工作树、无 tracked 文件或 reparse point；分别为63文件/1,897,192 bytes和2文件/1,579 bytes。拒绝后额外删除实际为0，未换用其他删除方式；保留65文件/1,898,771 bytes，不将其记为已清理。此项不影响已完成的功能测试和运行资源清理。

项目 API 404不能单独证明资源零残留，RBAC/网络读取失败也不能当空列表。只允许按本次 owner/project/记录的 run/share 精确清理，不扫旧项目或平台 MySQL PVC。清理失败保留安全账本，且不覆盖主失败所在阶段。

## 发布边界

本轮无 cloud deploy、生产迁移、push 或 merge。发布顺序为加法迁移 → 后端 → 前端；回滚保留新表与分享收据。操作说明见[功能与部署路径](../../run-result-sharing.md)，设计与任务状态见[设计](../../../../docs/superpowers/specs/2026-11-16-run-result-sharing-design.md)及[计划](../../../../docs/superpowers/plans/2026-11-16-run-result-sharing.md)。
