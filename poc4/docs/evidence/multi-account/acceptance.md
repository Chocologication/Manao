# 多账号与账号生命周期验收记录

- 更新：2026-10-30 22:35（**正式转态部署完成：注册/邮件正式启用（清单 env，非临时补丁）、邮件文案改相对有效期、AI 入口恢复；用户人工 E1–E6 PASS；云端两账号隔离/8 项目上限/改密撤销/跨账号拒绝/公开应用匿名访问 PASS；E7 NOT_RUN（用户未执行、未取得明确豁免）；C1 用户口头确认已轮换但历史 scrub 未完成（不得在 scrub 前 push/merge/publish）**）
- 分支：codex/multi-account（独立 worktree，不链接本地绝对路径）；修复/部署提交 f8f39ec、3a10a9f、1f53e50 及本 docs 提交；部署镜像 backend d560ec2a… / frontend 74c58830…
- 记录状态：**6B 正式部署 + 真实迁移/策略迁移/镜像 captcha/依赖隔离 + 用户人工邮件 E1–E6 + 云端两账号部分验收 PASS；E7 与云端终端/到期/后台继续等项仍有 NOT_RUN；MULTI_ACCOUNT_MVP_PASS 未授予（§12.6 为权威判定）。**
- **MULTI_ACCOUNT_MVP_PASS 未授予。** 正式部署本身已完成且 PASS；整体验收因 E7 NOT_RUN、云端终端/AI/日志跨 owner 与自然到期/后台继续证据未重造、C1 历史 scrub 未完成而不授予，不能由 mock/fixture/本地测试替代。

权威设计：[多账户与账号生命周期设计](../../../../docs/superpowers/specs/2026-10-29-multi-account-design.md)；
实施计划：[多账号实施计划](../../../../docs/superpowers/plans/2026-10-29-multi-account-implementation-plan.md)；
任务报告与独立复核：本地 SDD 目录 `.superpowers/sdd/2026-10-29-multi-account/`（该目录按仓库
本地 exclude 配置不入库，仅作本工作分支的工作记录；结论以本文件为准）。

## 1. 状态口径

| 状态 | 含义 |
| --- | --- |
| PASS | 在标注的环境中实际执行并通过；必须能给出命令/日志/回读等证据来源 |
| FAILED | 实际执行且失败（记录命令、错误与影响） |
| SKIPPED | 明确不适用或按设计跳过（写明原因） |
| NOT_RUN | 尚未执行（写明阻塞/前置条件） |
| NOT_REVERIFIED | 曾验证过，但当前代码/环境变化后未重新验证 |
| WAIVED_BY_USER | 用户明确豁免 |

测试代码存在、mock 通过、fixture 通过、源码审阅、用户人工验证分别记录，**互不替代**。
本轮本地日志在 `%TEMP%`（不入库）；入库证据为各任务提交、实现者报告与本文件命令结果。

## 2. 结论摘要

已实现并取得本地证据（详见 §3/§4/§5）：

- 依赖 NetworkPolicy 项目级收窄 + 旧策略迁移脚本（fixture 16/16）+ Task-1 M8 修复。
- 前端统一会话终止（expiry/logout/401 等价清理、迟到响应快照守卫）。
- V17 账号身份/一次性挑战 schema、V18 挑战配额分配锁；旧账号/项目保留。
- 图形验证码 + 邮箱验证码（一次性、冷却、限次、重发失效；仅捕获型 sender 与测试替身）。
- 注册 / 邮箱找回 / 改密 HTTP 流程与固定错误码；改密/重置后旧 JWT、旧票据、旧显示连接撤销，
  Run/AI 后台任务不停止（本地定向与竞态测试）。
- 三个账号页面 + 客户端撤销信号（WS 4401、SSE auth.revoked、一次性 /auth/me）；登录页无图形码。
- mock 浏览器验收 4/4（注册两步→登录、找回两步→登录、改密→重新登录、登录页入口/无演示凭据）。
- 旧账号邮箱人工绑定脚本自测 10/10（disposable schema，只创建/删除自有 test schema）。
- 前端 typecheck/build/dist mock 字符串扫描/boundary 均通过；前端全量 vitest 非全绿（见 §5 诚实记录）。
- 后端完整 Maven 套件（disposable MySQL，HEAD b132fb1）：**1076 tests / 0 failures / 0 errors / 2 skipped，
  BUILD SUCCESS（39:54）**；2 skipped 为真实集群/清理证据的环境门（未启用系统属性），非产品失败。
- K1（改密成功提示丢失）已由 Task 7 fix round 3 修复，mock e2e 已断言“恰好一次且不复播”。
- Task 6 terminal 撤销竞态 N1 与异常安全 M-a 已修复（fa5ac26/fcedcc4/b132fb1），修复轮复审 PASS；
  M-b/M-c/M-d 记录为最终分诊项。

部署前（2026-10-30 17:15）仍为 NOT_RUN、不阻塞本地交付但阻塞整体 PASS 的项（部署后更新见 §12，本节保留为历史快照）：

- 真实 126 邮件发送/收件与用户人工邮件验收（E1–E7；需注入 MAIL_PASSWORD 并临时开启开关，且仅由用户手动操作）。
- 真实云端两账号顺序验收（登录/项目/文件/Run/终端/AI、跨账号拒绝、8 项目上限、完整网络/workspace 旁路探测），需用户提供两个 verified 账号与专用项目或另行授权创建受控临时账号。
- 真实 owner/project 运行时资源清理（本地 disposable 测试 schema 清理已在 §5.6 PASS）。
- C1 提醒：仓库 baseline 预先存在的明文凭据必须在任何 push/merge/发布前轮换并清理历史
  （非本分支引入、本 worktree 未修改；详见 §9 C1，不复制任何 secret 值）。
- 2026-10-30 部署后：上述第一、二项已部分/全部执行（E1–E6、两账号隔离/8 项目/改密撤销/
  跨账号拒绝、公开应用匿名 PASS；E7 NOT_RUN；终端/AI/日志跨 owner/自然到期/后台继续未重造），
  资源清理与 C1 边界见 §12.5/§9 C1/§12.6。

## 3. 代码提交与任务级证据

任务实现以 commit 为准；下表“本地证据”是实现者报告 + Lead 定向验证的记录（Phase B-1 未重跑
后端任务级命令；Phase B-2 已执行完整套件，见 §5.6），独立复核记录见本地 reviews 目录。

| 任务 | 提交 | 本地证据（实现者/Lead） | 独立复核结论 |
| --- | --- | --- | --- |
| T1 依赖隔离 + 迁移脚本 | 9607b18、7aacf37、e19c938 | Java 定向 21/21；PS fixture 15/15（PS 5.1；精确 pwsh NOT_RUN） | 两轮修复后 PASS；遗留 1 项非阻断 Minor M8 由 T8 修复（f39c788，fixture 16/16） |
| T2 统一会话终止 | 5fe82aa、c310eb1、1714aec | Lead 定向 104/104 + typecheck 0 | 两轮修复后独立复审 PASS |
| T3 V17 + 版本化 JWT | 181d87d、d6a1a20 | Lead 53/53（定向 11 类）；后续组合 72/72 | 修复轮后 PASS；当时 strict-mapper 跨控制器 WARN 已由最终全量套件 **1076/0/0/2 PASS 覆盖（D9 RESOLVED）** |
| T4 图形码/邮箱码/SMTP 适配 | 37b65fa、fd7da3a、79fb2d8 | Lead 组合 72/72；T5 终态组合 112/112（含 T4 类） | 两轮修复后 PASS（N1 首码冷却由 79fb2d8 修复；**N2 cleanup 事务隔离已由 af94477 的 REQUIRES_NEW 修复**；N4/N5/N6 为 ACCEPTABLE-DEFERRED） |
| T5 注册/找回/改密 HTTP | 9d44ac6、2fac1a7 | Lead 113/113（19 类）；终态组合 112/112 | 独立复核 PASS/APPROVED（仅 Minor/[WARN]） |
| T6 撤销旧凭据/流 | 9c65719、af94477、fa5ac26、fcedcc4、b132fb1 | 定向 56/56 → follow-up 组合 111/111 → fix1 58/58 与组合 112/112 → fix2 组合 113/113；Lead 定向 36/36（b132fb1） | **PASS（fix rounds 后）**：初轮 review CHANGES NEEDED（N1）→ fix1 限定复审 PASS（N1 +(a)–(f) ADDRESSED）→ b132fb1 修 M-a（异常安全，最终整分支复核已核）；M-b/M-c/M-d 由最终复核判定 ACCEPTABLE-DEFERRED（D5） |
| T7 账号页面 + 客户端撤销 | 4fac593、333aadf、28fb5d5、390f6a4 | 定向 209/209、adjacent 414/414、typecheck/build/boundary 通过；mock e2e 4/4 | 两轮修复后 APPROVED；K1 fix（390f6a4）复审 PASS/APPROVED |
| T8 Phase A 交付物 | f39c788 | PS fixture 16/16、bind 自测 10/10、mock e2e 4/4、6b YAML 解析通过；均未 Apply | 本任务交付物；独立复核 NOT_RUN |
| T8 Phase B-1 证据/文档 | f453be8 | 见 §5（前端全量/typecheck/build/dist/boundary/mock e2e，deploy 脚本复跑） | 独立复核 NOT_RUN |
| T8 Phase B-2 最终本地证据 | 本记录所在 docs 提交 | 后端完整套件 1076/0/0/2 PASS（§5.6）；其余同 §5 | 本任务交付物；**最终整分支复核 DONE（本地 APPROVED，条件 C1/I1/I2；见 §9 R2）** |
| T8 Phase C 正式转态与回归 | f8f39ec、3a10a9f、1f53e50 | 邮件文案改相对有效期（SmtpVerificationMailSenderTest PASS）；6B 清单/模板正式启用 registration+mail；Dockerfile/README 明确产品构建必须 VITE_ENABLE_AI=true；重建 backend/frontend 镜像并部署（§12.1） | 本任务交付物；独立复核见 §12.8 |

复核主体说明：初始几轮独立审查由 codex/Astra 子代理完成；2026-10-29 用户模型策略变更后，
后续复核改由 DSH teammate `reviewer-guard`（deepseek-flash，只读）执行（Task 4 fix2、Task 5、
Task 6 follow-up、Task 7 K1 fix 等），**不是 codex**。最终整分支复核已完成（本地 APPROVED，
条件 C1/I1/I2；见 §9 R2 与本地 review 记录，不是 codex）。

## 4. 验收矩阵

列说明：code/local tests = 本机自动化（可 mock/fixture/捕获替身）；independent review = 本地独立复核；
user-manual email = 真实 126 邮件由用户手动完成；policy preview+apply = 真实集群策略迁移；
two-account isolation = 真实云端两账号；cloud acceptance = 真实公网入口。

> 注：本表是 2026-10-30 部署前的状态快照；部署后的正式转态、两账号/邮件/公开应用验收与
> PASS 判定见 §12（权威，冲突时以 §12 为准）。

| # | 验收项 | 证据来源 | code/local tests | independent review | user-manual email | policy preview+apply | two-account isolation | cloud acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 依赖 NetworkPolicy 项目标签 + 创建顺序 | T1 report/tests | PASS（21/21） | PASS（M8 已修） | SKIPPED | NOT_RUN | NOT_RUN | NOT_RUN |
| 2 | 旧策略迁移脚本（预览/备份/Patch/回读/零遗漏/统一失败） | T1 + T8 scripts/fixtures + §10 真实集群记录 | PASS（fixture 18/18，PS 5.1；精确 pwsh NOT_RUN；新增真实集群 kind=List 修复 c529fcb） | PASS（复审 + M8 闭环） | SKIPPED | **PASS（真实预览+Apply+回读：2/2 收窄，幂等 ALREADY_SCOPED；§10）** | NOT_RUN | NOT_RUN |
| 3 | 会话终止等价（expiry/logout/401 + 迟到响应） | T2 report/tests | PASS（104/104 Lead 定向） | PASS | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 4 | V17 账号 schema + 旧账号/项目保留 | T3 report / Flyway tests | PASS（53/53；disposable MySQL） | PASS（fix 轮；跨控制器 strict-mapper WARN 已由最终全量套件 RESOLVED） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 5 | V18 挑战配额分配锁 | T4 fix / FlywaySchemaTest | PASS（Flyway latest 18；定向组合包含） | PASS（N3 由 Lead 裁定接受） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 6 | 图形码（5 位去混淆 PNG/2 分钟/5 次/一次性/总量限速） | T4 report/tests | PASS（CaptchaServiceTest 等；**本地 JVM headless 渲染测试**） | PASS | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 6b | **实际 backend 镜像生成可解码 PNG（部署后 GET /api/v1/auth/captcha smoke）** | §10 真实部署记录（镜像 digest 7442351d…） | **PASS（真实镜像返回 200，PNG 132x44 可解码，Cache-Control: no-store）** | PASS（Lead 执行；证据见 §10） | SKIPPED | SKIPPED | NOT_RUN | PASS（公网入口） |
| 7 | 邮箱码（6 位/10 分钟/5 次/60s 冷却/小时 5 次/重发失效/SMTP 失败状态） | T4/T5 report/tests | PASS（捕获型 sender/替身；无真实 SMTP） | PASS | **NOT_RUN（用户手动）** | SKIPPED | NOT_RUN | NOT_RUN |
| 8 | 注册/找回/改密 HTTP 合同与固定错误码 | T5 report/HTTP tests | PASS（113/113 Lead；终态组合 112/112） | PASS/APPROVED | NOT_RUN（用户手动） | SKIPPED | NOT_RUN | NOT_RUN |
| 9 | 改密/重置撤销旧 JWT、票据、连接；Run/AI 继续 | T6 report/tests | PASS（fix1 58/58 + 组合 112/112 → fix2 113/113；完整套件含 T6 类全绿） | PASS（fix1 复审 N1+(a)–(f) ADDRESSED；最终复核已核 b132fb1 M-a FIXED；M-b/M-c/M-d 判为 ACCEPTABLE-DEFERRED D5） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 10 | 前端页面/transport/撤销信号 | T7 report/tests | PASS（209/209 定向 + 414/414 adjacent） | PASS/APPROVED | NOT_RUN（用户手动） | SKIPPED | NOT_RUN | NOT_RUN |
| 11 | mock 浏览器 e2e（3 条账号流程 + 登录页） | 本文件 §5.4 / Playwright | PASS（4/4，含 K1 banner 断言） | NOT_RUN（本任务交付物） | SKIPPED（mock 不代表真实邮件） | SKIPPED | SKIPPED | NOT_RUN |
| 12 | 前端全量回归（vitest/typecheck/build/boundary） | 本文件 §5.1–§5.3 | **非全绿**：1736 tests 中 4 failed（已知 visual spec + 3 个负载 flake；隔离 92/92 PASS）；typecheck/build/boundary PASS | NOT_RUN | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 13 | 后端完整 Maven 套件（全局 strict Jackson/V17+V18/无关控制器） | 本文件 §5.6（Phase B-2） | **PASS（1076 tests / 0 failures / 0 errors / 2 skipped，BUILD SUCCESS，39:54；disposable MySQL）** | PASS（最终整分支复核已核对 surefire artifact；全量非本轮重跑） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 14 | 旧账号邮箱人工绑定维护脚本 | T8 Phase A bind-legacy-email + self-test | PASS（10/10，disposable schema，本地 MySQL） | NOT_RUN（本任务交付物） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 15 | 邮件/挑战配置模板与 6B Secret/env 引用 | T8 Phase A + §10 部署记录 | PASS（结构/YAML 校验；mail+registration=false；password 空） | NOT_RUN | **PASS（AUTH_CHALLENGE_SECRET 随机注入；MAIL_PASSWORD 暂空、mail false）** | SKIPPED | NOT_RUN | NOT_RUN |
| 16 | 真实策略迁移预览 → 备份 → Apply → 回读 | **本文件 §10（2026-10-30 已执行）** | 本地 fixture PASS | PASS（脚本复审） | SKIPPED | **PASS（2 条旧策略收窄；backup/patch/apply-report；回读 UID 不变；幂等复检）** | NOT_RUN | NOT_RUN |
| 17 | 受控升级：部署/V17+V18 真实迁移/旧 JWT 重登/回读 | **本文件 §10（2026-10-30 已执行）** | **PASS（V16→V18；旧账号/项目数据保留；旧格式 JWT 401；ver=0 token 200；/me 回读）** | Lead 执行 + 证据 §10 | NOT_RUN（旧密码登录未测，密码未提供） | PASS（策略） | NOT_RUN | PASS（公网入口） |
| 18 | 用户人工邮件验收 E1–E7 | 本文件 §8（部署前快照；部署后 E1–E6 PASS、E7 NOT_RUN，见 §12.3） | **NOT_RUN（当时）** | NOT_RUN | **部署后 E1–E6 PASS / E7 NOT_RUN（§12.3）** | SKIPPED | SKIPPED | PASS（E1–E6，公网入口） |
| 19 | 两账号顺序验收 + 跨账号拒绝 + 8 项目上限 | 本文件 §6.4 / §12.4（部署前快照） | 云端 spec 2 passed/3 skip；API 补充验证 | NOT_RUN | NOT_RUN | NOT_RUN | **PARTIAL PASS（已执行子集；终端/AI/到期/后台继续未重造，见 §12.4/§12.6）** | PASS（已执行子集） |
| 20 | 网络隔离探测（依赖连通/跨项目拒绝/公开应用/旁路） | **本文件 §10（依赖隔离已执行）** | PASS（两项目 workspace→自身 MySQL 服务/Pod IP OPEN；跨项目 BLOCKED(rc=11) 双向） | Lead 执行 | SKIPPED | PASS | **NOT_RUN（两账号 HTTP/workspace 旁路）** | NOT_RUN（公开应用当前无运行中 app） |
| 21 | 清理：本地 disposable 测试 schema vs 真实 owner/project 运行时资源 | 本文件 §5.6 / 计划 Task 8 第 5 项 | PASS（本地 disposable 测试 schema 自动创建/删除，无新增残留；未 reset 运行库） | NOT_RUN | NOT_RUN | NOT_RUN | **NOT_RUN（真实 owner/project 运行时资源清理）** | NOT_RUN |
| 22 | C1：仓库 baseline 预先存在的明文凭据（非本分支引入） | 最终复核 C1（本地 review 记录，不入库；未复制任何 secret 值） | **NOT_RUN / REMINDER**：任何 push/merge/发布前必须轮换并清理历史；本 worktree 未修改、分支 diff 未触碰 | NOT_RUN | — | — | — | — |
| 23 | **MULTI_ACCOUNT_MVP_PASS** | 本文件 §11 | **NOT_GRANTED** | — | — | — | — | — |

## 5. 本地执行证据（Phase B-1/B-2，2026-10-29/30，最终 HEAD b132fb1 + 本任务 docs 提交）

环境：Windows；Node 24.12.0；pnpm 10.33.0；Playwright 1.62.1 + chromium 可用；
Java 17.0.16；Maven 3.9.16（~/.m2 wrapper dist）；本地 MySQL 8.0.43（disposable schema）；
pwsh 二进制不存在（Windows PowerShell 5.1.26100.7344）。以下命令均在 `poc4/frontend` 或仓库根
执行；未连接真实集群/SMTP/真实邮箱。

### 5.1 前端完整 vitest（诚实记录，非全绿）

```
cd poc4/frontend && pnpm exec vitest run
Test Files  4 failed | 98 passed (102)
     Tests  4 failed | 1732 passed (1736)
  Duration  137.35s
```

失败明细（4 个失败文件）：

| 文件/测试 | 归因 | 隔离复跑 |
| --- | --- | --- |
| tests/visual/ai-ui.spec.ts | **已知既有问题**：Playwright 规范被 vitest 收集，报 “Playwright Test did not expect test() to be called here”；该文件在本分支未被修改（base..HEAD diff 为空） | 单独运行仍以同一原因失败（预期） |
| src/components/shell/WorkbenchShell.test.tsx > moves AI history ... / traps narrow history focus ... | 并发负载下重型 UI 计时 flake | 与另外两个文件一起隔离复跑 PASS |
| src/components/runs/RunEvidence.test.tsx > marks activity read ... | 并发负载下重型 UI 计时 flake | 同上 PASS |
| src/features/projects/ProjectRoutePage.test.tsx > redrives a committed-but-lost change ... | 并发负载下 lazy editor/loading 计时 | 同上 PASS |

隔离复跑命令与结果：

```
pnpm exec vitest run src/components/shell/WorkbenchShell.test.tsx src/components/runs/RunEvidence.test.tsx src/features/projects/ProjectRoutePage.test.tsx
Test Files  3 passed (3)
     Tests  92 passed (92)      exit 0
```

结论：前端全量套件**不是全绿**；4 个失败均为已知既有（1）或并发负载 flake（3，隔离全绿）。
不把隔离通过当作全量通过，也不把 flake 归因于本分支。

### 5.2 typecheck / production build / dist 扫描 / boundary

```
pnpm typecheck          -> exit 0
pnpm build              -> exit 0（"✓ built in 48.56s"；仅 >500kB chunk 警告）
Select-String dist/assets/*.js -Pattern 'mock-captcha|mock-email-|演示账号|demo-pass|mock-token'
                        -> NO_MOCK_AUTH_STRINGS_IN_DIST
pnpm test:boundary      -> 36 tests / 36 pass / 0 fail；"Browser boundary check passed."；exit 0
```

### 5.3 部署脚本复跑（当前树；Phase A 交付物未被改坏）

```
powershell -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1
-> PASS=16 FAIL=0，REPAIR_EXIT=0
powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -SelfTest
   （MANAO_DB_URL=jdbc:mysql://127.0.0.1:3306/manao_poc4_test；MANAO_DB_USERNAME=manao；空密码）
-> PASS=10 FAIL=0；自建 manao_stage6_t8_<32hex> 并 DROP；BIND_SELFTEST_EXIT=0
```

精确 `pwsh -NoProfile -File ...` 命令仍 **NOT_RUN**（本机无 pwsh）；PS 5.1 等价命令通过，
脚本按 5.1/7 兼容编写。

### 5.4 mock 浏览器验收（含 K1 修复后的断言）

```
cd poc4/frontend
pnpm exec playwright test --config playwright.multi-account.config.ts
Running 4 tests using 1 worker
   ok 1 register: two mock steps create the account and the new credentials log in
   ok 2 forgot password: two mock steps reset the password and the new one logs in
   ok 3 change password: success terminates the session and requires a re-login
   ok 4 login page offers registration and recovery entries and no captcha or demo credentials
   4 passed (1.1m)      exit 0
```

测试 3 现在断言：/login 上“密码已更新，请重新登录”提示恰好一次；旧密码被拒绝；新密码可登录并
可返回工作台；随后显式退出后再次访问 /login 不复播该一次性提示。配置只启动本项目 mock
Vite build+preview（4188 端口），MSW 替身；无 backend、SMTP/IMAP、真实账号或真实邮件。

### 5.5 云端 spec：只校验收集，不执行

```
pnpm exec playwright test --config playwright.multi-account-cloud.config.ts --list
-> Total: 5 tests in 1 file（cloud 2 + NOT_RUN gates 3）
```

真实云端执行 **NOT_RUN**：缺 `MANAO_MULTI_ACCOUNT_BASE_URL` 与用户手动创建/验证的两个账号
及专用项目；配置无 webServer、无 MSW、workers=1，baseURL 仅来自 env；spec 不申请真实邮箱码、
不读 IMAP、不绕过图形码。

### 5.6 后端完整 Maven 套件（Phase B-2）：PASS

```
MANAO_DB_URL=jdbc:mysql://127.0.0.1:3306/manao_poc4_test
MANAO_DB_USERNAME=manao
MANAO_DB_PASSWORD=
& 'C:\Users\shili\.m2\wrapper\dists\apache-maven-3.9.16\56ba1f9f\bin\mvn.cmd' -B -f poc4/backend/pom.xml test

[INFO] Tests run: 1076, Failures: 0, Errors: 0, Skipped: 2
[INFO] BUILD SUCCESS
[INFO] Total time:  39:54 min
MVN_EXIT=0
```

这是首个覆盖全局 strict Jackson mapper、V17+V18 迁移、组件扫描/YAML 绑定和全部与账号无关
控制器的完整回归；**无失败/错误**，仅 2 个环境门 SKIPPED（如实记录，非产品失败）：

| 跳过测试 | 原因（源码事实） |
| --- | --- |
| com.manao.poc4.deploy.Stage6aPreflightTest.realClusterPreflightFailsWhenKubeconfigMissingInRealMode | 需要系统属性 `-Dmanao.stage6.real=true`（真实集群预检；本轮未启用真实集群） |
| com.manao.poc4.project.ProjectCleanupEvidenceTest.registeredProjectsHaveNoOwnerScopedResidue | 类级 `@EnabledIfSystemProperty(manao.stage6.cleanup.verify=true)`（真实清理残留核验；本轮未启用） |

诊断噪声分类：日志中的 `[Fatal Error] ... "testsuite" ...` 来自
`DevelopmentBuildExecutorTest` 故意注入的畸形 Surefire XML fixture（测试源码内
`unterminated attribute` 用例），用于验证失败构建报告解析；该类 32/32 PASS，不是套件失败。

DB 卫生：套件通过 JdbcStoreTestSupport 创建并在结束时删除各自的 `manao_stage6_<uuid>` schema；
运行后仅剩运行前已存在的两个历史遗留 `manao_stage6_a7779c…` / `manao_stage6_edea20…`（未新增
残留）；`manao_poc4` 未被写入（仅名称核对），本地无 `manao_poc4_6b`。未连接真实集群/邮件。

## 6. 迁移与部署步骤（2026-10-30 已执行 6.1/6.2/6.3/6.5；6.4 与真实邮件同日执行，结果见 §12.3/§12.4）

> 2026-10-30 用户授权后，6.1 V17+V18 运行库迁移、6.2 旧策略预览+Apply、6.3 挑战 Secret 注入、6.5 实际镜像 captcha PNG smoke 已实际执行，完整执行记录与证据见 §10；同日 6.4 两账号云端验收（部分）与用户人工邮件 E1–E6 已执行，E7/终端/到期/后台继续边界见 §12.3/§12.4/§12.6。

### 6.1 V17 + V18 运行库迁移（真实 manao_poc4 / manao_poc4_6b）

已确认事实（本地 disposable schema 已验证，运行库未执行）：

- V17：app_user 增加 email VARCHAR(254)（utf8mb4_bin 唯一）、email_verified_at、auth_version；
  新增 auth_challenge 一次性挑战表；log_ticket / terminal_session 增加可空 auth_version。
  旧行不重写、email 不回填，旧 id/owner 不变。
- V18：新增 auth_challenge_allocation 分配锁表并写入 captcha / email_send_slot 两行（纯新增），
  用于图形码总量与邮箱发送槽的原子分配；Flyway latest = 18。
- 新 backend 启动时由 Flyway 顺序应用 V17、V18；失败即启动失败（fail-closed）。

授权窗口内步骤（未执行）：

1. 记录目标 deployment 镜像 SHA/digest 与 DB 备份/恢复点；确认注册/邮件开关 false。
2. 先在备份/恢复点可回退的前提下，按 6.2 完成旧策略预览与（获准的）Apply 或确认无需迁移。
3. 准备 6.3 的 Secret keys（缺失会 CreateContainerConfigError，属预期 fail-closed）。
4. 单 backend Recreate 部署含本分支的镜像；等待 Flyway 应用 V17+V18 与 readiness 通过。
5. 回读：Flyway schema history 到 18；app_user 新列与旧账号/项目数、owner 不变；旧密码可登录
   （登录签发 ver 版 JWT）；旧 JWT 一律重新登录一次；旧 NULL ticket 被拒绝（预期，用户重登）；
   注册/找回开关关闭时入口拒绝。
6. 回滚不 down-migrate、不恢复宽 NetworkPolicy；若必须回退镜像，不得宣称撤销/隔离修复仍有效。

### 6.2 旧依赖 NetworkPolicy 预览与 Apply（真实集群）

已交付脚本与证据：poc4/deploy/multi-account/repair-dependency-policy.ps1；本地 fixture 16/16
（默认预览不写集群/不写文件、零遗漏、fail-closed、UID/resourceVersion 冲突停止、只 patch
podSelector、统一失败报告等）。**真实集群预览/Apply 均为 NOT_RUN。**

授权窗口内步骤（未执行）：

```
# 1) 只读预览（默认，无 -Apply；由操作者从真实集群整理并人工审阅 ProjectsFile）
powershell -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.ps1 -Context <kubectl-context> -Namespace <namespace> -ProjectsFile <reviewed-projects.json> -OutputDirectory <empty-dir>
# 预期：逐项 [ALREADY_FIXED]/[NEEDS_MIGRATION]/[MISSING]/[UNKNOWN_SPEC]/[OUT_OF_SCOPE]；
# 只有 RESULT=ALREADY_SCOPED 或完整 PREVIEW_RESULT=WOULD_PATCH 且无拒绝项才可继续。
# 2) 备份与人工确认后 Apply（仅在获准窗口）
powershell -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.ps1 -Context <kubectl-context> -Namespace <namespace> -ProjectsFile <reviewed-projects.json> -OutputDirectory <dir> -Apply
# 预期：backup/<policy>.json、patch/<policy>.json、apply-report.json；[PATCHED]/[VERIFIED] 回读；
# 任何失败 exit 3 且不重试、不继续后续策略。
```

部署顺序：先部署含项目级 selector 修复的 backend（或与其在同一变更窗口），否则旧 backend 可能
重新创建宽 target 策略，需要重跑预览/迁移。回滚不得恢复宽放行。

### 6.3 邮件/挑战运行时 Secret（未执行）

- `MANAO_AUTH_CHALLENGE_SECRET`（≥32 随机字节）与 `MANAO_MAIL_PASSWORD`（126 客户端授权码）
  只能由运行时 Secret（poc4/deploy/6b/backend.yaml 引用 manao-backend-auth 的
  AUTH_CHALLENGE_SECRET / MAIL_PASSWORD）注入；仓库内 config.example.env 保持空值。
- 仅在授权的人工验收窗口临时启用 MANAO_MAIL_ENABLED=true / MANAO_REGISTRATION_ENABLED=true，
  验收后恢复 false；agent 不执行真实发送、SMTP 登录探测或邮箱读取。

### 6.4 两账号顺序云端验收（2026-10-30 已执行，见 §12.4）

前提：用户手动完成 E1/E2（真实注册/找回收信与验证码提交）并准备两个 verified 账号与专用项目。
之后使用 `playwright.multi-account-cloud.config.ts`（无 MSW/webServer，baseURL 仅 env，workers=1）
执行登录→项目/文件→（扩展后）运行/终端/AI→退出，B 顺序重复；覆盖跨账号项目/文件/Run/ticket/
conversation/task ID 替换拒绝、A 到期→B 登录、旧响应迟到、改密后旧 JWT/ticket/连接失效且后台
任务继续、注册开关与旧账号绑定、每账号 8 项目第 9 个拒绝。网络探测项另按计划执行。

2026-10-30 已使用用户提供的 test_user_1/test_user_2 与专用项目执行：Playwright cloud spec
2 passed / 3 显式 skip（内置 NOT_RUN gate 保留）；隔离、8 项目上限、改密撤销、跨账号拒绝 PASS，
公开应用匿名访问 PASS；未重造的边界见 §12.4。

### 6.5 实际 backend 镜像与 captcha PNG 解码 smoke（未执行；I1）

- 设计要求：实际 backend 镜像必须能生成可解码 PNG（字体/headless 渲染，设计 §5.3）；**本地 JVM
  headless PNG 渲染测试通过不等于真实镜像通过**。
- 现状：Task 4 报告明确记录实际镜像 PNG 验证 **NOT_RUN（Docker engine 不可用）**；本文件矩阵新增
  6b 行、§9 P1 行与 §7 清单项，均不以本地 JVM 测试结果替代真实镜像证据。
- 授权窗口步骤（未执行）：构建/运行含本分支的 backend 镜像并记录 digest → 请求
  `GET /api/v1/auth/captcha` → 校验 200、`imageBase64` 可 base64 解码为有效 PNG（PNG 签名/尺寸/
  解码库可解析）→ 记录镜像 digest 与结果；失败记 FAILED，不得以本地测试替代。

## 7. 需要用户授权的真实环境操作清单

以下为原始授权清单；其中 2/3/4（含 §6.5 PNG smoke）/5/6/10（依赖隔离探测部分）已于 2026-10-30 用户授权窗口执行（结果见 §10），其余仍待授权或由用户手动完成：

1. **C1（安全前提）**：在任何 push/merge/发布前轮换并清理仓库 baseline 预先存在的明文凭据
   （非本分支引入、本 worktree 未修改；不复制任何 secret 值）。
2. 只读连接真实集群并运行旧策略迁移预览（kubectl context/namespace/ProjectsFile 由操作者提供）。
3. 对真实集群 Apply 旧策略迁移（产生 NetworkPolicy patch 与 backup/apply-report 证据）。
4. 构建/推送并部署含本分支的 backend 镜像，单 backend Recreate；并执行 §6.5 的实际镜像
   `GET /api/v1/auth/captcha` PNG 解码 smoke（含 6.3 前提，记录镜像 digest）。
5. 在真实运行库（manao_poc4 / manao_poc4_6b）应用 V17+V18（须先记录 DB 恢复点；禁止 reset schema）。
6. 创建/注入 Secret keys：AUTH_CHALLENGE_SECRET、MAIL_PASSWORD（以及既有 JWT/镜像引用不变）。
7. 临时启用 MANAO_MAIL_ENABLED / MANAO_REGISTRATION_ENABLED 的人工验收窗口，并在结束后恢复 false。
8. 真实 126 邮件发送/收信与验证码提交（仅用户手动；agent 禁止）。
9. 真实云端 Playwright 两账号顺序验收（用户提供 base URL、两个账号与专用项目 id）。
10. 真实网络隔离探测（依赖连通/跨项目 Service-Pod 拒绝/公开应用匿名可用/workspace-platform 旁路）。——**2026-10-30 已执行**：依赖隔离 §10.6 PASS；公开应用匿名访问 §12.5 PASS；跨账号文件/Run/ticket/conversation/task 拒绝 §12.4 PASS，未发现跨账户读写旁路。
11. 精确 owner/project 的运行时资源清理（不得删平台 MySQL PVC、不得删除旧账号项目）。
12. 对运行库执行任何其它写操作（如 bind-legacy-email.ps1 -Apply 绑定旧账号邮箱；须先确认邮箱控制权）。
13. 上述真实证据齐全并复核后，更新本验收记录并评估 MULTI_ACCOUNT_MVP_PASS。——2026-10-30 复核后：正式部署 PASS；**MVP_PASS 未授予**（E7 NOT_RUN、云端终端/AI/日志与到期/后台继续证据不足、C1 scrub 未完成；见 §12.6）。

## 8. 用户人工邮件验收清单（E1–E6 PASS；E7 NOT_RUN）

> 由用户手动完成；agent 不触发真实邮件、不读取 IMAP、不记录授权码/验证码/密码。
> 每行由用户填写 PASS/FAILED、日期与脱敏备注；不记录任何秘密值。
> 前置：2026-10-30 正式部署已启用邮件/注册（清单 env），不再恢复 false；见 §12.1。

| # | 场景 | 操作步骤（用户） | 预期结果 | 用户结果 | 日期 | 备注（脱敏） |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 正常注册送达 | /register 输入新用户名/邮箱/密码与图形码，发送邮箱验证码，查收 126 邮件并提交 | 邮件送达；6 位码可提交；注册成功回登录页（不自动登录） | PASS | 2026-10-30 18:35 | 用户手动完成并反馈"没有问题" |
| E2 | 正常找回送达 | /forgot-password 用已绑定邮箱发码，查收并重置 | 邮件送达；重置成功；新密码可登录，旧密码失效 | PASS | 2026-10-30 18:40 | 用户手动；E6 随后验证旧密码失效 |
| E3 | 验证码过期 | 取得邮箱码后等待超过 10 分钟再提交 | 提交被拒绝；不创建账号/不重置密码 | PASS | 2026-10-30 18:49 | 用户手动 |
| E4 | 重发使旧码失效 | 发送后用“重新发送”，只使用旧邮件里的旧码提交 | 旧码被拒绝；新码可用（60 秒冷却生效） | PASS | 2026-10-30 18:49 | 用户手动 |
| E5 | 重复提交拒绝 | 用已消费的验证码再次提交注册/重置 | 拒绝；不产生第二个账号/第二次重置 | PASS | 2026-10-30 18:49 | 用户手动 |
| E6 | 重置后旧密码失效 | 找回重置成功后用旧密码登录 | 旧密码失败；新密码成功；旧凭据被撤销 | PASS | 2026-10-30 18:45 | 用户手动 |
| E7 | 未绑定邮箱旧账号 | 旧 NULL email 账号尝试找回；并用 bind-legacy-email 预览核对 | 统一提示且不泄露账号存在性；绑定需人工脚本+用户确认控制权 | NOT_RUN | — | 用户未执行，也未取得明确豁免；旧账号绑定属用户侧运维操作，脚本仅自测 10/10，真实 -Apply 未执行 |

当前整体邮件链状态：**PASS（E1–E6 用户手动，2026-10-30）；E7 NOT_RUN（用户未执行/未豁免）**。
agent 未发送任何真实邮件、未读取邮箱、未记录验证码/授权码；邮件内容后续改为相对有效期（§12.2）。

## 9. 已知问题与开放项

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| K1 | 改密成功后登录页提示曾因 RequireAuth 重定向覆盖 router state 而缺失 | 提示语缺失（安全行为正常） | **FIXED（390f6a4）**：改为一过性内存提示，恰好一次、不复播；独立复核 PASS/APPROVED；本轮 mock e2e 已断言 |
| K2 | 2026-10-30 正式部署后工作台 AI 入口消失 | 前端 AI 面板由构建期 VITE_ENABLE_AI 门控；首次多账号部署构建未传 --build-arg VITE_ENABLE_AI=true，AI 入口被编译掉 | **FIXED（1f53e50 + 重建镜像 74c58830…）**：按 AI=true 重建/部署；浏览器实测 tabs=["代码","运行记录","AI"]；文档/Dockerfile 注释已补硬性构建参数；见 §12.7 |
| N1 | Task 6 terminal 撤销竞态分支未结算 LIVE session（复核发现，静态分析无复现） | 可能遗留 LIVE 行/active marker，后续 terminal 409 | **FIXED（fa5ac26 + fcedcc4）**：closeRevoked 走单会话 settleAndClose；确定性 stale-version 测试覆盖 4401、PTY 未开、无 LIVE、INTERRUPTED 恰一次、后续 reserve 成功；fix1 复审 PASS |
| M-a | 终止门非异常安全（CAS 后 send 抛 RuntimeException 可能永久残留 LIVE） | 与 N1 同类后果（异常路径） | **FIXED（b132fb1）**：try/finally 保证 settle/close；throwing fake session 测试；Lead 定向 36/36；最终整分支复核已核（保留多会话异常循环残余 Minor，D5 deferred） |
| M-b/M-c/M-d | Task 6 fix 轮遗留：部分路径回归测试缺口、stale-version 帧序契约未固定、SSE auth.revoked 改为尽力异步的语义说明 | 测试/契约清晰度；不阻断功能 | **ACCEPTABLE-DEFERRED（最终复核已分诊，D5）**：记录在 reviews/task-6-fix1-rereview.md；确认非 Critical/Important |
| B1 | 后端完整 Maven 套件未运行（Maven 与 Task 6 修复轮串行） | 全局 strict Jackson/V18/无关控制器全量回归未验证 | **PASS（Phase B-2）**：1076 tests / 0 failures / 0 errors / 2 skipped，BUILD SUCCESS，39:54，disposable MySQL（2 skipped 为真实集群/清理证据的环境门） |
| P1 (I1) | 实际 backend 镜像 PNG 渲染验证（设计 §5.3） | 真实部署的 GET /api/v1/auth/captcha 返回 PNG | **PASS（2026-10-30，§10）**：真实镜像 digest 7442351d…；HTTP 200、PNG 132x44、PNG 签名有效、Cache-Control: no-store；证据文件 smoke-captcha.png 在本地 deploy-evidence |
| F1 | 前端全量 vitest 非全绿：1 个已知 visual spec + 3 个并发负载 flake（隔离 92/92 PASS） | 不能声称前端全量绿 | 记录为已知/环境性；未改源码 |
| F2 | 精确 `pwsh -NoProfile -File ...` 无法执行（本机无 pwsh） | 两脚本 ps1 证据仅 PS 5.1 | NOT_RUN（环境限制；PS 5.1 等价 PASS） |
| D11 | 邮件正文固定"10 分钟"，而 `MANAO_AUTH_EMAIL_CODE_TTL` 可配置（默认 10m） | 非默认 TTL 下文案可能与实际不符（本部署为默认 10m，无影响） | **ACCEPTABLE-DEFERRED（Minor）**：用户要求原文"有效期10分钟内"且本部署默认一致；后续若覆盖 TTL 需同步正文/参数；sender 仍保留 expiresAt 形参以兼容接口 |
| R1 | 复核 deferred minors：T4 N4/N5/N6（N2 已由 af94477 修复）、T5 若干 Minor、T6 M-b/M-c/M-d、T7 M1–M4 | 不阻断本地交付 | **DONE（最终复核分诊）**：均 ACCEPTABLE-DEFERRED（D1–D10）；无未解决 Critical/Important 代码项 |
| R2 | 最终整分支独立复核 | 本地交付质量门 | **DONE（2026-10-30）**：本地分支 **APPROVED**；交付 YES 条件为文档 MUST-FIX **C1/I1/I2**；真实环境 NOT_RUN；**MULTI_ACCOUNT_MVP_PASS 未授予**。记录：本地 `.superpowers/sdd/2026-10-29-multi-account/reviews/final-whole-branch-review.md`（review 记录，不入库） |
| S1 | 真实 SMTP/邮件、集群/部署/Secret、V17+V18 运行库迁移、实际镜像 PNG、两账号/网络/清理、用户验收 | 真实环境验收与 PASS 门 | **PARTIAL（2026-10-30 更新）**：正式部署/迁移/策略/PNG/依赖隔离、E1–E6、两账号隔离/8 项目/改密撤销/跨账号拒绝、公开应用匿名 PASS；E7 NOT_RUN、云端终端/AI/日志跨 owner 与到期/后台继续未重造、C1 scrub 未完成；**整体 MVP_PASS 未授予（§12.6）** |
| C1 | 仓库 baseline 预先存在的明文凭据（.claude/settings.local.json、.zcode/config.json、docs/old_docs/.../2026-09-26-python-runtime-review-fix-plan.md；非本分支引入，本 worktree 未修改） | 任何 push/merge/发布前必须轮换并清理历史；本文件不复制任何 secret 值 | **WAIVED_BY_USER（仅"已轮换"确认；2026-10-30）**：用户口头确认"已经轮换了"；**仓库历史仍含 baseline 明文凭据，scrub 未执行**，因此在完成历史清理或用户明确书面豁免前**禁止 push/merge/发布**；本分支不复制任何 secret 值 |

## 10. 真实 6B 集群部署执行记录（2026-10-30，用户授权）

授权：用户 2026-10-30 16:45 明确“可以发布到集群并进行下一步工作”。执行位置：本地独立 worktree（codex/multi-account），context kubernetes-admin@learn，namespace manao-stage6b；部署前 3 节点 Ready。日志/输出/备份在本地 .superpowers/sdd/2026-10-29-multi-account/deploy-evidence/（repo 本地 exclude，不入库）；本文件只记录结论与关键值。

### 10.1 部署前基线与恢复点

- 部署源码：分支 HEAD 430d64d（本地实现 + docs；镜像构建于此），迁移工具修复 c529fcb（真实集群 generic List kind 兼容，仅部署脚本，不打入镜像）。
- 部署前镜像：backend chocologic/manao_images_repository@sha256:c0c56bc3…，frontend …@sha256:120ebc30…（旧 digest 已记录，可用于受控回退；本轮未回退）。
- 部署前 DB：Flyway history 最新 version=16；app_user=1、project=6（1 个 DELETING）、log_ticket=98、run=14、workspace_operation=131、agent_task=22、agent_conversation=12。
- DB 恢复点：deploy-evidence/db-backup-manao_poc4_6b-20261030-1710.sql（mysql-0 内 mysqldump --single-transaction --routines --triggers --events，kubectl cp 回本地后删除 pod 临时文件），size=3,050,141 bytes，sha256=4f0a01156c1359a28bf0cf0b65d57c46661e4fe0480d14df4326a1211594b277。
- 另存部署前 deployment/pods/networkpolicies YAML 到 deploy-evidence（不含 Secret 值）。

### 10.2 镜像构建、推送与 Secret

- backend：docker build -t chocologic/manao_images_repository:multi-account-backend-20261030 poc4/backend → push → digest sha256:7442351d2144e3de33c364a3b66720cd999825fb6a3f61e3c6071469e3b0caf9。
- frontend：docker build -t chocologic/manao_images_repository:multi-account-frontend-20261030 poc4/frontend → push → digest sha256:be7f667ce7553ec8462915986e8d9c52d19a113df37dc226f04cbb3136e5ac5e。（**更正**：该首次构建未传 --build-arg VITE_ENABLE_AI=true，AI 入口被编译掉；2026-10-30 晚以 1f53e50 重建 digest 74c58830… 并部署，见 §12.1/§12.7。）
- Secret manao-backend-auth 追加 AUTH_CHALLENGE_SECRET（随机 48 字节 base64，未出现在仓库/日志/报告）与 MAIL_PASSWORD（当前空字符串；真实 126 授权码未注入，mail 保持 false）。
- Secret manao-backend-images 的 BACKEND_IMAGE 更新为新 digest；workspace/runner 镜像引用不变。backend.yaml/frontend.yaml 以 digest 替换 placeholder 后 apply（渲染文件在 deploy-evidence）。

### 10.3 部署与 V17+V18 迁移

- backend 单副本 Recreate、frontend 单副本滚动；两次 rollout 成功（backend Pod backend-7ddb87c845-5jvjw、frontend Pod frontend-6776f7c449-4xcjs，均 Ready 1/1）。
- backend 启动日志：Current version of schema manao_poc4_6b: 16 → 应用 V17、V18 → Successfully applied 2 migrations ... now at version v18（0.395s）；应用启动成功。旧账号/项目未重建、未 reset schema。
- 部署后 DB 回读：flyway version=18；app_user=1、project=6、log_ticket=98、run=14、workspace_operation=131（与部署前一致）；auth_challenge 表存在（smoke 产生 1 行）、auth_challenge_allocation=2；98 条旧 log_ticket 的 auth_version 均为 NULL；app_user email=NULL、email_verified_at=NULL、auth_version=0。
- 旧 JWT 行为：旧格式（无 ver）调用 /api/v1/projects → 401；ver 不匹配 → 401；签发当前 ver=0 token → 200 并列出 6 个项目。既有登录会话需重新登录一次。

### 10.4 部署后 smoke（全部通过）

- 公网入口 http://1.12.245.235:30080：index 200；GET /api/v1/auth/options → {registrationEnabled:false,emailAvailable:false}。
- GET /api/v1/auth/captcha（经公网入口）：200；base64 解码为有效 PNG（signature 89 50 4E 47 0D 0A 1A 0A，132x44），响应头 Cache-Control: no-store；无答案泄漏字段。**实际 backend 镜像 PNG 验证 PASS。**
- 未认证 GET /api/v1/projects → 401 UNAUTHENTICATED；登录错误密码 → 401 通用信息；GET /api/v1/auth/me（合法 ver=0 token）→ 200，返回既有账号 id/username、email=null、emailVerified=false；GET /api/v1/projects/<已有READY项目id> → 200 且 id/state 匹配。
- 真实浏览器（Playwright chromium 对公网入口）：/login 有“注册账号”“忘记密码”入口、无图形码、无演示凭据；/register 显示注册关闭状态；/forgot-password 显示邮箱输入与统一找回/未绑定邮箱提示；三页 URL 均 200；生产 bundle 含 /register、/forgot-password、/account/password 路由及“注册账号/忘记密码/修改密码”文案。
- 健康：backend readiness/liveness 均 {"status":"UP"}；部署后日志无 ERROR/Exception。

### 10.5 旧依赖 NetworkPolicy 真实迁移

- 工具修复：真实 kubectl get networkpolicies -o json 顶层 kind=List（非 NetworkPolicyList），原脚本 fail-closed 中止；修复为接受两种 list kind 且要求每个 item 为 NetworkPolicy，fixture 18/18 PASS（commit c529fcb）。
- 只读预览（ProjectsFile = 人工核对的 2 个现有依赖策略项目 a5a24746…/bdddc018…）：[NEEDS_MIGRATION]×2、[IGNORED] ai-stage1-development-build-egress（无 ingress）、PREVIEW_RESULT=WOULD_PATCH count=2，exit 0，无写入。
- Apply：先写 backup 与 patch payload（仅 NetworkPolicy）；JSON Patch 校验 /metadata/uid 与 /metadata/resourceVersion 且仅 replace podSelector；两条均 [PATCHED]+[VERIFIED]，UID 不变、resourceVersion 由 41395899/38518186 变为 41805612/41805628；apply-report 写入本地证据目录；无 Secret 读取、无范围扩展。
- 幂等复检：再次只读预览 → 两条 [ALREADY_FIXED]、RESULT=ALREADY_SCOPED count=0，exit 0。
- live selector 回读：两条 target 均为 project-id=<本项目> + component In(mysql,redis)，ingress 来源仅本项目；ai-stage1-development-build-egress 未改。

### 10.6 网络隔离探测（真实）

从两个项目的 workspace Pod 分别探测本项目和另一项目的依赖 MySQL（3306）：

| 源项目 | 目标 | 结果 |
| --- | --- | --- |
| a5a24746 workspace | 自身 MySQL Service / Pod IP | OPEN / OPEN（connect_ex 0） |
| a5a24746 workspace | bdddc018 MySQL Service / Pod IP | BLOCKED(rc=11) / BLOCKED(rc=11) |
| bdddc018 workspace | 自身 MySQL Service / Pod IP | OPEN / OPEN |
| bdddc018 workspace | a5a24746 MySQL Service / Pod IP | BLOCKED / BLOCKED |

结论：自身依赖连通、跨项目 Service 与 Pod IP 连接均被拒绝；不存在“连接成功但密码错误”。公开应用当前无运行中 app（两个 app Service 无 endpoints，HTTP 502），因此“公开应用匿名可访问”本轮 NOT_RUN（未启动新 Run 以免改变用户项目状态）；依赖策略目标仅为依赖 Pod，不改变公开应用路径。

### 10.7 边界与未完成项

- 旧账号密码登录未执行：集群既有账号密码未提供（operator 不保存/不猜测）；旧账号数据保留与 /me/project 回读已用 operator 签发的 ver=0 token 验证，不等同于真实密码登录。
- 旧 NULL ticket 运行期拒绝、改密后真实连接撤销、两账号 HTTP/workspace 旁路、8 项目上限、公开应用匿名访问仍 NOT_RUN（需真实账号/Run）。
- 真实 126 邮件 E1–E7 当时仍 NOT_RUN；当时 MAIL_PASSWORD 为空且 mail/registration=false。
  （历史快照；2026-10-30 22:00 正式转态后注册/邮件已由清单 env 启用，见 §12.1；真实邮件仅用户手动。）
- C1 baseline 明文凭据清理未执行（非本分支引入；push/merge/发布前必须完成）。
- 回退：旧 backend/frontend digest 已记录，可按受控发布流程回退镜像；按计划不得 down-migrate、不得恢复宽 NetworkPolicy、不得回退到忽略 auth_version 的旧镜像并声称撤销有效。
## 11. PASS 判定

**MULTI_ACCOUNT_MVP_PASS 未授予。**

授予条件（按设计与计划）：范围内证据齐全，即代码/本地测试、独立复核、用户人工邮件验证、
旧策略预览+Apply 回读、两账号隔离与云端验收全部有真实证据，且无未解决 Critical/Important。
当前本地范围已闭环：后端完整套件 1076/0/0/2 PASS（disposable MySQL）、前端 typecheck/build/dist/
boundary PASS、mock 浏览器验收 4/4 PASS、部署/维护脚本 fixture PASS，K1 与 Task 6 N1/M-a 已修复；
前端全量 vitest 仍有 1 个已知既有 visual spec 失败 + 3 个隔离即通过的负载 flake（如实记录）。
最终整分支复核已完成：**本地分支 APPROVED**，交付 YES 以完成文档 MUST-FIX（C1/I1/I2）为条件，
复核明确不授予 MVP_PASS。真实 126 邮件、真实集群/V17+V18 迁移与旧策略 Apply、**实际 backend
镜像 captcha PNG 解码 smoke**、云端两账号隔离、网络探测、真实 owner/project 清理、C1 凭据轮换
与用户人工验收仍 NOT_RUN。因此只能记录“本地范围内可复核的通过项”与明确 NOT_RUN 边界，
**MULTI_ACCOUNT_MVP_PASS 仍不授予，也不能由 mock/fixture 替代真实邮件、真实镜像与云端验收**。

（历史快照，已被下方正式转态记录取代）2026-10-30 部署后更新：受控升级、V17+V18 真实迁移、旧策略 Apply+回读、实际镜像 captcha PNG、依赖隔离探测已 PASS；当时剩余未完成项为真实 126 邮件人工 E1–E7、云端两账号顺序验收/完整网络与 workspace 旁路/8 项目上限、公开应用匿名访问（需启动 app Run）、真实 owner/project 资源清理、C1 凭据轮换与用户最终验收。

**2026-10-30 22:00–22:30 正式部署与验收更新：** 用户人工邮件 E1–E6、云端两账号登录/项目文件隔离/
8 项目上限/改密撤销/跨账号文件/Run/log-ticket/conversation/agent-task 拒绝、公开应用匿名访问、
正式转态部署与 AI 入口回归已完成；C1 用户口头确认轮换但历史 scrub 未完成；E7 NOT_RUN。
经独立复核（§12.8），初稿的 MVP_PASS 授予判断**已撤回**：云端终端/AI/日志跨 owner 与自然到期/
后台继续证据未重造，故 **MULTI_ACCOUNT_MVP_PASS 未授予**；逐项状态与边界见 §12.6（权威）。

## 12. 2026-10-30 正式部署与用户/云端验收更新（权威）

> 本节记录部署后（2026-10-30 22:00–22:30）的正式转态与验收结果；§4、§6.4、§7、§8、§11 中
> 标注 NOT_RUN 的条目如与本节点冲突，以本节为准。所有时间为 Asia/Shanghai（用户会话时区）。
> 证据文件在本地 `.superpowers/sdd/2026-10-29-multi-account/deploy-evidence/`（repo 本地
> exclude，不入库）；本节只记录结论与关键值，不复制 token/验证码/授权码/密码。
> 本地 evidence 同样按 no-secret 要求处理：2026-10-30 复核发现原始 Deployment YAML 的
> last-applied 注解含 runtime token 值后，已删除这些原始 YAML 与 Secret patch 副本；保留的
> summary/pods/options/image-labels/cleanup-readback 均不含 secret 值（删除前未提交、未外发）。

### 12.1 正式部署转态（用户要求"将临时状态改为正式部署多账户功能的状态"）

- 授权与决定：用户于 2026-10-30 完成人工邮件验收（E1–E6 PASS）后要求转为正式部署；注册与邮件
  从"临时验收窗口"改为正式启用，不再恢复 false。
- 代码/配置提交：f8f39ec（邮件文案改相对有效期）、3a10a9f（6B 清单与模板正式启用
  registration/mail，构建/部署文档补充）、1f53e50（Dockerfile 注释明确产品构建必须
  VITE_ENABLE_AI=true）；本记录 docs 提交。
- 镜像（linux/amd64，构建于 1f53e50，label org.opencontainers.image.revision=1f53e5084a92b8117a658b229ae0b3111b707e95）：
  - backend：`chocologic/manao_images_repository@sha256:d560ec2ac2fd56060912ec6799422a9ed87e12434ad4db76aaa6690776ed2ca2`
  - frontend：`chocologic/manao_images_repository@sha256:74c5883059e8c99e1af1c4ede14d970a88a9ec674d8f050234418499ac58905c`（`VITE_ENABLE_AI=true`）
- 部署：Secret manao-backend-images 的 BACKEND_IMAGE 更新为上述 backend digest；backend.yaml/
  frontend.yaml 以 digest 渲染后 apply；backend 单副本 Recreate（Pod backend-7dbc9657bb-x84kn）、
  frontend 滚动（Pod frontend-647d58687b-kspqf），rollout 均成功、Ready 1/1。
  清单 env 中 `MANAO_REGISTRATION_ENABLED=true` / `MANAO_MAIL_ENABLED=true`（来自 6B 清单，
  不是 kubectl set env 临时补丁）；`MANAO_MAIL_PASSWORD` 仍只从 Secret
  `manao-backend-auth/MAIL_PASSWORD` 注入。
- 启动与接口回读：Flyway validated 18 / no migration necessary；应用启动成功；公网
  `GET /api/v1/auth/options` → `{"registrationEnabled":true,"emailAvailable":true}`。
- 部署后回读（2026-10-30 22:2x）：本地 127.0.0.1:6443 隧道曾中断，随后使用经证书校验的直连
  （server=https://1.12.245.235:6443 + tls-server-name=127.0.0.1，CA/客户端证书不变）完成回读，
  保存 `postdeploy-summary-20261030-2230.txt`、`postdeploy-pods-20261030-2230.txt`、
  `postdeploy-options-20261030.json`、`image-labels-20261030.txt`、
  `postdeploy-cleanup-readback-20261030.txt`（原始 Deployment YAML 因 last-applied 注解含 runtime
  token 值，已在复核后删除，不再作为证据文件保留）：backend/frontend rollout 均 successfully rolled out，
  Pod backend-7dbc9657bb-x84kn / frontend-647d58687b-kspqf 均 Running 1/1；清单 env 回读
  MANAO_REGISTRATION_ENABLED=true / MANAO_MAIL_ENABLED=true；options 回读与上同。未执行回退；
  旧 digest（backend 7442351d…、frontend be7f667…）与 predeploy 快照保留，可按受控流程回退。
- 镜像 revision label 回读见 `image-labels-20261030.txt`（backend/frontend 均为
  `1f53e5084a92b8117a658b229ae0b3111b707e95`），与构建/推送日志一致。

### 12.2 邮件文案（用户红框要求）

- 用户截图发现邮件正文绝对时间"有效期至 2026-10-30 13:47:16"是服务器时区渲染，与用户本地
  （21:37）不一致；用户要求改为相对文案。
- 修改（f8f39ec）：正文改为"有效期 10 分钟内，请尽快使用。"；删除绝对时间格式化与相关 import。
  后端定向测试 `SmtpVerificationMailSenderTest` 断言包含新文案且不含"有效期至"，PASS。
- 该改动随 §12.1 backend 新镜像部署；用户后续触发真实邮件时可直接观察新文案（agent 不发送邮件）。
- 已知限制 D11（Minor，记录为 ACCEPTABLE-DEFERRED）：正文分钟数目前为固定"10 分钟"（与设计默认
  `emailCodeTtl=10m` 及本次部署一致）。`MANAO_AUTH_EMAIL_CODE_TTL` 若被非默认值覆盖，正文需同步；
  本次部署未覆盖该配置。sender 仍保留 expiresAt 形参以兼容接口。

### 12.3 用户人工邮件验收（E1–E6 PASS；E7 NOT_RUN）

- 用户 2026-10-30 反馈（原话）：“E1/pass/10月30日18:35 E2/pass/10月30日18:40
  E6/pass/10月30日18:45 E3，E4，E5/pass/10月30日18:49 以上实测均没有问题”。
  逐项记录见 §8（E1–E6 PASS；E7 NOT_RUN）。
- agent 未发送任何真实邮件、未读取邮箱、未记录验证码/授权码；SMTP 参数与 MAIL_PASSWORD 未在
  仓库/日志/本记录中出现真实值。
- E7（旧 NULL email 账号人工绑定路径）**NOT_RUN**：用户未执行，也未取得明确豁免；旧账号仍
  email NULL，binding 脚本仅自测 10/10，真实 `-Apply` 需确认邮箱控制权后另行执行。该场景是
  MVP_PASS 的未满足条件之一（§12.6），不能以"转正式部署"推断为 waiver。

### 12.4 云端两账号顺序验收（已验证项 PASS；未覆盖边界见下）

- 环境：公网入口 `http://1.12.245.235:30080`；账号 A=`test_user_1`、B=`test_user_2`
  （用户提供，登录后 /auth/me 均 emailVerified=true）；专用项目 A=`test_project_1`
  （0aa40631-204b-4758-b84a-c35bfb6a673c）、B=`test_project_2`
  （3a382725-5ce4-4200-8bfe-8c9e16e802ab）。
- 自动化：设置 `MANAO_MULTI_ACCOUNT_*` 后运行
  `pnpm exec playwright test --config playwright.multi-account-cloud.config.ts`
  → **2 passed / 3 skipped，exit 0**；日志 `cloud-multi-account-20261030.log`。3 个 skip 是脚本
  内置显式 NOT_RUN gate（真实邮件；改密撤销/自然到期/后台继续；8 项目+写/票据/会话跨账号边界），
  不是失败，也**不能**当作已通过；后两类本次用补充 API 脚本部分覆盖，但不替代 cloud spec 的
  端到端项。已执行覆盖：A→B 顺序登录（无图形验证码）、/auth/me email/verified 回读、各自项目
  列表、own 项目/文件树 200、跨账号 404（双向）。
- 补充 API 验收（`cloud-revocation-crossaccount.log`）：
  - 改密撤销：登录 200 → `POST /auth/password-change` 204 → 旧 JWT 的 /me 与 /projects 均 401
    → 旧密码登录 401 → 新密码登录 200 → 改回 204 → 改回后旧 token /projects 401 →
    新密码 401 / 原密码 200（密码已还原）。
  - 跨账号拒绝：A 写 B 文件 404；A 在 B 启 Run 404；A 读 B conversations 404；B 读 A 当前
    agent-task 404；B 写 A 文件 404；未认证读文件树 401；B 读 A 的 run 404；B 为 A 的 run
    申请 log-ticket 404（A 为自己的 run 申请 200 且返回 ticket，值未记录）。
  - 空列表语义：跨账号 `GET /projects/{other}/runs` 返回 200 空页（与随机 UUID 相同，不返回
    任何行）；单 run/ticket 查询按 owner 拒绝，无数据泄漏；active 返回 `{"run":null}`。
  - 8 项目上限：B 初始 1 个项目；创建 7 个至 8 个后，第 9 个创建 409
    `{"code":"PROJECT_LIMIT_REACHED"}`；随后 7 个新建项目 DELETE 204，列表回到 1；
    K8s 清理回读：`postdeploy-cleanup-readback-20261030.txt` 对 8 个 disposable project id
    （7 个 quota + 公开应用项目）回读 pod/pvc/deploy/svc 均无残留
    （`quota-b-20261030.log`、`quota-b-cleanup-20261030.log`）。
- 未重造/未覆盖（边界）：终端 PTY ticket 的云端跨账号替换、AI task/conversation 的端到端云端
  跨账号、A 自然到期→B 登录（需等 token TTL）、改密时后台 Run/AI 继续的云端长任务证据，仍由
  本地定向/组合测试覆盖（§5/§9 T6）；本次未在云端重造，这些项**不转成 PASS**，也是 §12.6 不授予
  整体 MVP_PASS 的原因之一。
- 无效探测分诊：`cloud-revocation-crossaccount.log` 中 `b_read_a_run_logs status=500` 使用的
  `/api/v1/projects/{id}/runs/{runId}/logs` 并非接口契约路径（RunController 无该映射；属未匹配
  路径的处理错误），不作为安全证据；真实的日志入口是
  `POST .../runs/{runId}/log-ticket`，跨账号实测 404（已 PASS）。

### 12.5 公开应用匿名访问（PASS）

- 用测试账号 A 创建一次性 web 项目 `test_public_web`（模板 `java-spring-boot-web`，
  publicPort 30090，creationKey `acceptance-public-web-20261030`），READY 后按 workspace
  revision=19 启动 run。
- run `312408e5-0abb-4b0a-b779-589036bbbee6` firstReadyAt=`2026-10-30T14:09:25Z`
  （=22:09:25 Asia/Shanghai），state=RUNNING。
- 匿名访问（无 Cookie/Authorization）：`GET http://1.12.245.235:30090/api/demo?name=Anon`
  → **HTTP 200**，body `{"message":"Hello from Manao","timestamp":"2026-10-30T14:09:29.839197179Z"}`；
  证明公开应用保持匿名可用。证据 `public-app-20261030.log`。
- 结束后 `POST /runs/{id}/stop` → state CANCELLED；停后同一 URL 不可达（curl 000）；
  `DELETE /projects/{id}` → 204；项目列表回读 A 回到 1 个项目（test_project_1 READY），
  GET 已删项目 404；`postdeploy-cleanup-readback-20261030.txt` 对该项目 id 的 pod/pvc/deploy/svc
  回读无残留；DELETE 204 亦表示后端清理流程完成（未完成会返回 503 PROJECT_CLEANUP_INCOMPLETE）。

### 12.6 更新后的验收状态与 PASS 判定（MVP_PASS 未授予）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 代码/本地测试（此前） | PASS | §3/§5 |
| delta 独立复核 | **APPROVED（2026-10-30，round-4）**；首轮 CHANGES NEEDED 项均已修正 | §12.8 |
| 真实 6B 正式部署 + V17/V18 迁移 + 旧策略 Apply + 旧 JWT 重登 | PASS | §10、§12.1 |
| 用户人工邮件 E1–E6 | PASS（用户手动，2026-10-30） | §8/§12.3 |
| 用户人工邮件 E7（旧 NULL email 人工绑定） | NOT_RUN（未执行、未取得豁免） | §8/§12.3 |
| 云端两账号：登录/项目文件隔离/8 项目上限/改密撤销/文件·Run·log-ticket·conversation·agent-task 跨账号拒绝 | PASS（已验证子集） | §12.4 |
| 云端终端 PTY 跨账号、AI task/conversation 端到端、自然到期→B、改密时后台 Run/AI 继续 | NOT_RUN（未重造） | §12.4 |
| 公开应用匿名访问 | PASS | §12.5 |
| 依赖 NetworkPolicy 跨项目隔离 | PASS | §10.6 |
| 实际镜像 captcha PNG | PASS | §10.4 |
| AI 入口回归 | FIXED | §9 K2/§12.7 |
| C1 baseline 明文凭据 | WAIVED_BY_USER（仅"已轮换"确认；历史 scrub 未完成） | §9 C1 |
| 邮件正文 TTL 硬编码 | ACCEPTABLE-DEFERRED（D11，Minor） | §9 D11/§12.2 |

**MULTI_ACCOUNT_MVP_PASS：未授予（2026-10-30；撤回初稿"授予"判断）。**
已满足：正式部署与迁移/策略/镜像 captcha/依赖隔离、E1–E6、云端两账号已执行的隔离与拒绝、
8 项目上限、改密撤销、公开应用匿名、AI 入口回归。
未满足/未覆盖（不转成 PASS）：
- E7 NOT_RUN（用户未执行、未取得明确豁免）；
- 设计验收要求的终端/AI/日志跨 owner 云端证据与 A 自然到期→B 登录、改密时后台 Run/AI 继续的
  云端长任务证据未重造；cloud spec 的 3 个显式 skip 与本地定向/组合测试不能替代；
- C1 仅用户口头确认轮换，仓库历史仍含 baseline 凭据，scrub 未完成，因此 push/merge/publish
  继续禁止；
- 前端全量 vitest 仍有 1 个已知 visual spec + 3 个负载 flake（§5.1 原样保留）。
后续路径：用户对上述范围（尤其 E7 与云端未重造项）给出明确豁免或补齐证据后，再评估授予；
不得把 NOT_RUN 改写成 PASS。

### 12.7 AI 入口回归（K2）

- 现象：正式部署后用户发现工作台 AI 入口消失（截图 2026-10-30 21:49）。
- 根因：前端 AI 面板由构建期 `VITE_ENABLE_AI` 门控（Dockerfile ARG 默认 false）。2026-10-30
  首次多账号部署构建前端时未传 `--build-arg VITE_ENABLE_AI=true`，AI 入口被编译掉。
- 修复：以 1f53e50 重建前端镜像（digest 74c58830…）并部署；生产 bundle 含
  `workbench-tab-agent`；真实浏览器登录测试账号进入工作台，tabs = ["代码","运行记录","AI"]，
  AI tab 可见（证据 `ai-entry.png`）。部署/构建文档与 Dockerfile 注释已补硬性构建参数
  （3a10a9f、1f53e50），避免再次遗漏。

### 12.8 独立复核（delta）

- 复核范围：f8f39ec、3a10a9f、1f53e50 与本 §12/§8/§9 文档更新。
- 复核人：DSH teammate `reviewer-guard`（deepseek-flash，只读，不是 codex/Astra）。
- 第 1 轮结论：**CHANGES NEEDED**（代码/配置 delta 本身可接受；验收/MVP_PASS 声明 overclaim）。
  要求：E7 不得记 WAIVED、撤回 MVP_PASS、收敛 acceptance/plan 矛盾、C1 改 WAIVED 边界、分诊
  `b_read_a_run_logs` 500、补部署/清理回读证据；Minor：邮件 TTL 硬编码。
- 处理（2026-10-30 22:3x）：E7→NOT_RUN；MVP_PASS 撤回并保持 NOT_GRANTED；header/§2/§6/§7/§8/
  §9/§11/§12 与 plan、what-we-have-done 统一；C1→WAIVED_BY_USER 且保留 push/merge/publish 禁令；
  `/logs` 500 分诊为无效探测路径；补 `postdeploy-*` 部署/清理回读证据；TTL 硬编码记为 D11
  ACCEPTABLE-DEFERRED（本部署默认 10m，无功能影响）。
- 第 2 轮结论：**CHANGES NEEDED**（round-1 修复均验证通过；剩余问题：本地原始 Deployment YAML
  的 last-applied 注解含 runtime token 值；cleanup-readback 仅有一行汇总、未逐 id/资源记录）。
  处理：删除上述原始 Deployment YAML 与 Secret patch 副本（未提交、未外发；如曾复制/分享该文件，
  应轮换相关 runtime token）；生成逐 8 个 disposable project id 的
  `postdeploy-cleanup-readback-20261030.txt`（pods/pvc/deploy/svc 逐项 count=0）；§12.1/§12.4/
  §12.5 同步为 summary/readback 证据，不再引用已删除 YAML。
- 第 3 轮结论：**CHANGES NEEDED**（cleanup/删除/token 扫描均已通过；剩余：本地仍有渲染脚本会
  重建含 last-applied token 的原始 Deployment YAML、一个审计清单仍列已删文件名、轮次标签不一致、
  两个 local-only JSON 仍含测试 password 字段）。
  处理：删除该渲染脚本与审计清单；对 evidence 内 `password/currentPassword/newPassword` 字段
  统一脱敏（扫描后无剩余明文）；§12.6 轮次标签同步 round-4。
- 第 4 轮结论：**APPROVED（2026-10-30）**。复核确认：删除文件无残留引用；剩余 evidence 无
  JWT/token 值、password 字段均为脱敏占位；cleanup-readback 8 个 id 逐项 0；文档主状态一致；
  仅剩"已脱敏 password key 可再删除"的 advisory，无 Critical/Important。
