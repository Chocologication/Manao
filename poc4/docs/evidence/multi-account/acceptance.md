# 多账号与账号生命周期验收记录

- 更新：2026-10-30（最终整分支复核后的 docs 对齐：I1 实际镜像 PNG NOT_RUN、I2 状态刷新、C1 提醒；真实环境仍 NOT_RUN）
- 分支：codex/multi-account（独立 worktree，不链接本地绝对路径）；最终本地树 HEAD b132fb1 + docs 提交
- 记录状态：**本地实现、前端全量/mock、后端完整套件与全部本地证据已记录；最终整分支复核：本地 APPROVED（条件 C1/I1/I2）；真实环境仍 NOT_RUN。**
- **MULTI_ACCOUNT_MVP_PASS 未授予。** 真实邮件、云端两账号隔离、旧策略 Apply、部署/V17+V18
  真实迁移、实际 backend 镜像 PNG 验证、C1 凭据清理与用户人工验收尚未完成；本地测试通过不等于真实环境验收。

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

仍为 NOT_RUN（不阻塞本地交付，但阻塞整体 PASS）：

- 真实 126 邮件发送/收件与用户人工邮件验收（E1–E7）。
- **实际 backend 镜像生成可解码 PNG（部署后 GET /api/v1/auth/captcha smoke）**：Docker engine 不可用；
  当前只有本地 JVM headless PNG 渲染测试通过，真实镜像渲染仍 NOT_RUN（Task 4 报告明确记录）。
- 真实集群旧策略只读预览/Apply/回读、部署、Secret 注入、V17+V18 真实运行库迁移。
- 真实云端两账号顺序验收（登录/项目/文件/Run/终端/AI、跨账号拒绝、8 项目上限）、网络隔离探测。
- 真实 owner/project 运行时资源清理（本地 disposable 测试 schema 清理已在 §5.6 PASS）。
- C1 提醒：仓库 baseline 预先存在的明文凭据必须在任何 push/merge/发布前轮换并清理历史
  （非本分支引入、本 worktree 未修改；详见 §9 C1，不复制任何 secret 值）。

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

复核主体说明：初始几轮独立审查由 codex/Astra 子代理完成；2026-10-29 用户模型策略变更后，
后续复核改由 DSH teammate `reviewer-guard`（deepseek-flash，只读）执行（Task 4 fix2、Task 5、
Task 6 follow-up、Task 7 K1 fix 等），**不是 codex**。最终整分支复核已完成（本地 APPROVED，
条件 C1/I1/I2；见 §9 R2 与本地 review 记录，不是 codex）。

## 4. 验收矩阵

列说明：code/local tests = 本机自动化（可 mock/fixture/捕获替身）；independent review = 本地独立复核；
user-manual email = 真实 126 邮件由用户手动完成；policy preview+apply = 真实集群策略迁移；
two-account isolation = 真实云端两账号；cloud acceptance = 真实公网入口。

| # | 验收项 | 证据来源 | code/local tests | independent review | user-manual email | policy preview+apply | two-account isolation | cloud acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 依赖 NetworkPolicy 项目标签 + 创建顺序 | T1 report/tests | PASS（21/21） | PASS（M8 已修） | SKIPPED | NOT_RUN | NOT_RUN | NOT_RUN |
| 2 | 旧策略迁移脚本（预览/备份/Patch/回读/零遗漏/统一失败） | T1 + T8 scripts/fixtures | PASS（fixture 16/16，PS 5.1；精确 pwsh NOT_RUN） | PASS（复审 + M8 闭环） | SKIPPED | **NOT_RUN（真实集群未执行）** | NOT_RUN | NOT_RUN |
| 3 | 会话终止等价（expiry/logout/401 + 迟到响应） | T2 report/tests | PASS（104/104 Lead 定向） | PASS | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 4 | V17 账号 schema + 旧账号/项目保留 | T3 report / Flyway tests | PASS（53/53；disposable MySQL） | PASS（fix 轮；跨控制器 strict-mapper WARN 已由最终全量套件 RESOLVED） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 5 | V18 挑战配额分配锁 | T4 fix / FlywaySchemaTest | PASS（Flyway latest 18；定向组合包含） | PASS（N3 由 Lead 裁定接受） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 6 | 图形码（5 位去混淆 PNG/2 分钟/5 次/一次性/总量限速） | T4 report/tests | PASS（CaptchaServiceTest 等；**本地 JVM headless 渲染测试**） | PASS | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 6b | **实际 backend 镜像生成可解码 PNG（部署后 GET /api/v1/auth/captcha smoke）** | Task 4 report（Docker engine 不可用）/ §6.5 | **NOT_RUN（仅本地 JVM 渲染测试，不是真实镜像 PASS）** | NOT_RUN | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 7 | 邮箱码（6 位/10 分钟/5 次/60s 冷却/小时 5 次/重发失效/SMTP 失败状态） | T4/T5 report/tests | PASS（捕获型 sender/替身；无真实 SMTP） | PASS | **NOT_RUN（用户手动）** | SKIPPED | NOT_RUN | NOT_RUN |
| 8 | 注册/找回/改密 HTTP 合同与固定错误码 | T5 report/HTTP tests | PASS（113/113 Lead；终态组合 112/112） | PASS/APPROVED | NOT_RUN（用户手动） | SKIPPED | NOT_RUN | NOT_RUN |
| 9 | 改密/重置撤销旧 JWT、票据、连接；Run/AI 继续 | T6 report/tests | PASS（fix1 58/58 + 组合 112/112 → fix2 113/113；完整套件含 T6 类全绿） | PASS（fix1 复审 N1+(a)–(f) ADDRESSED；最终复核已核 b132fb1 M-a FIXED；M-b/M-c/M-d 判为 ACCEPTABLE-DEFERRED D5） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 10 | 前端页面/transport/撤销信号 | T7 report/tests | PASS（209/209 定向 + 414/414 adjacent） | PASS/APPROVED | NOT_RUN（用户手动） | SKIPPED | NOT_RUN | NOT_RUN |
| 11 | mock 浏览器 e2e（3 条账号流程 + 登录页） | 本文件 §5.4 / Playwright | PASS（4/4，含 K1 banner 断言） | NOT_RUN（本任务交付物） | SKIPPED（mock 不代表真实邮件） | SKIPPED | SKIPPED | NOT_RUN |
| 12 | 前端全量回归（vitest/typecheck/build/boundary） | 本文件 §5.1–§5.3 | **非全绿**：1736 tests 中 4 failed（已知 visual spec + 3 个负载 flake；隔离 92/92 PASS）；typecheck/build/boundary PASS | NOT_RUN | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 13 | 后端完整 Maven 套件（全局 strict Jackson/V17+V18/无关控制器） | 本文件 §5.6（Phase B-2） | **PASS（1076 tests / 0 failures / 0 errors / 2 skipped，BUILD SUCCESS，39:54；disposable MySQL）** | PASS（最终整分支复核已核对 surefire artifact；全量非本轮重跑） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 14 | 旧账号邮箱人工绑定维护脚本 | T8 Phase A bind-legacy-email + self-test | PASS（10/10，disposable schema，本地 MySQL） | NOT_RUN（本任务交付物） | SKIPPED | SKIPPED | NOT_RUN | NOT_RUN |
| 15 | 邮件/挑战配置模板与 6B Secret/env 引用 | T8 Phase A config.example.env / backend.yaml | PASS（结构/YAML 校验；mail+registration=false；password 空） | NOT_RUN | **NOT_RUN（运行时 Secret 注入未执行）** | SKIPPED | NOT_RUN | NOT_RUN |
| 16 | 真实策略迁移预览 → 备份 → Apply → 回读 | 本文件 §6.2（未执行） | 本地 fixture PASS | PASS（脚本复审） | SKIPPED | **NOT_RUN（需用户授权）** | NOT_RUN | NOT_RUN |
| 17 | 受控升级：部署/V17+V18 真实迁移/旧 JWT 重登/回读 | 本文件 §6.1（未执行） | **NOT_RUN** | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 18 | 用户人工邮件验收 E1–E7 | 本文件 §8（未执行） | **NOT_RUN（用户手动）** | NOT_RUN | **NOT_RUN（等待用户）** | SKIPPED | SKIPPED | NOT_RUN |
| 19 | 两账号顺序验收 + 跨账号拒绝 + 8 项目上限 | 本文件 §6.4 / cloud spec（未执行） | 云端 spec 骨架已就绪（--list 5 项） | NOT_RUN | NOT_RUN | NOT_RUN | **NOT_RUN（需用户授权）** | NOT_RUN |
| 20 | 网络隔离探测（依赖连通/跨项目拒绝/公开应用/旁路） | 计划 Task 8 第 4 项网络 | NOT_RUN | NOT_RUN | SKIPPED | NOT_RUN | NOT_RUN | NOT_RUN |
| 21 | 清理：本地 disposable 测试 schema vs 真实 owner/project 运行时资源 | 本文件 §5.6 / 计划 Task 8 第 5 项 | PASS（本地 disposable 测试 schema 自动创建/删除，无新增残留；未 reset 运行库） | NOT_RUN | NOT_RUN | NOT_RUN | **NOT_RUN（真实 owner/project 运行时资源清理）** | NOT_RUN |
| 22 | C1：仓库 baseline 预先存在的明文凭据（非本分支引入） | 最终复核 C1（本地 review 记录，不入库；未复制任何 secret 值） | **NOT_RUN / REMINDER**：任何 push/merge/发布前必须轮换并清理历史；本 worktree 未修改、分支 diff 未触碰 | NOT_RUN | — | — | — | — |
| 23 | **MULTI_ACCOUNT_MVP_PASS** | 本文件 §10 | **NOT_GRANTED** | — | — | — | — | — |

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

## 6. 迁移与部署步骤（全部未执行，需用户授权）

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

### 6.4 两账号顺序云端验收（未执行）

前提：用户手动完成 E1/E2（真实注册/找回收信与验证码提交）并准备两个 verified 账号与专用项目。
之后使用 `playwright.multi-account-cloud.config.ts`（无 MSW/webServer，baseURL 仅 env，workers=1）
执行登录→项目/文件→（扩展后）运行/终端/AI→退出，B 顺序重复；覆盖跨账号项目/文件/Run/ticket/
conversation/task ID 替换拒绝、A 到期→B 登录、旧响应迟到、改密后旧 JWT/ticket/连接失效且后台
任务继续、注册开关与旧账号绑定、每账号 8 项目第 9 个拒绝。网络探测项另按计划执行。均为 NOT_RUN。

### 6.5 实际 backend 镜像与 captcha PNG 解码 smoke（未执行；I1）

- 设计要求：实际 backend 镜像必须能生成可解码 PNG（字体/headless 渲染，设计 §5.3）；**本地 JVM
  headless PNG 渲染测试通过不等于真实镜像通过**。
- 现状：Task 4 报告明确记录实际镜像 PNG 验证 **NOT_RUN（Docker engine 不可用）**；本文件矩阵新增
  6b 行、§9 P1 行与 §7 清单项，均不以本地 JVM 测试结果替代真实镜像证据。
- 授权窗口步骤（未执行）：构建/运行含本分支的 backend 镜像并记录 digest → 请求
  `GET /api/v1/auth/captcha` → 校验 200、`imageBase64` 可 base64 解码为有效 PNG（PNG 签名/尺寸/
  解码库可解析）→ 记录镜像 digest 与结果；失败记 FAILED，不得以本地测试替代。

## 7. 需要用户授权的真实环境操作清单

以下操作**本轮均未执行**，需用户逐项授权（可分批）：

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
10. 真实网络隔离探测（依赖连通/跨项目 Service-Pod 拒绝/公开应用匿名可用/workspace-platform 旁路）。
11. 精确 owner/project 的运行时资源清理（不得删平台 MySQL PVC、不得删除旧账号项目）。
12. 对运行库执行任何其它写操作（如 bind-legacy-email.ps1 -Apply 绑定旧账号邮箱；须先确认邮箱控制权）。
13. 上述真实证据齐全并复核后，更新本验收记录并评估 MULTI_ACCOUNT_MVP_PASS（当前未授予）。

## 8. 用户人工邮件验收清单（未填写；NOT_RUN）

> 由用户手动完成；agent 不触发真实邮件、不读取 IMAP、不记录授权码/验证码/密码。
> 每行由用户填写 PASS/FAILED、日期与脱敏备注；不记录任何秘密值。
> 前置：仅在授权的验收窗口临时启用邮件/注册开关，验收后恢复 false。

| # | 场景 | 操作步骤（用户） | 预期结果 | 用户结果 | 日期 | 备注（脱敏） |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 正常注册送达 | /register 输入新用户名/邮箱/密码与图形码，发送邮箱验证码，查收 126 邮件并提交 | 邮件送达；6 位码可提交；注册成功回登录页（不自动登录） | 待填 | 待填 | — |
| E2 | 正常找回送达 | /forgot-password 用已绑定邮箱发码，查收并重置 | 邮件送达；重置成功；新密码可登录，旧密码失效 | 待填 | 待填 | — |
| E3 | 验证码过期 | 取得邮箱码后等待超过 10 分钟再提交 | 提交被拒绝；不创建账号/不重置密码 | 待填 | 待填 | — |
| E4 | 重发使旧码失效 | 发送后用“重新发送”，只使用旧邮件里的旧码提交 | 旧码被拒绝；新码可用（60 秒冷却生效） | 待填 | 待填 | — |
| E5 | 重复提交拒绝 | 用已消费的验证码再次提交注册/重置 | 拒绝；不产生第二个账号/第二次重置 | 待填 | 待填 | — |
| E6 | 重置后旧密码失效 | 找回重置成功后用旧密码登录 | 旧密码失败；新密码成功；旧凭据被撤销 | 待填 | 待填 | — |
| E7 | 未绑定邮箱旧账号 | 旧 NULL email 账号尝试找回；并用 bind-legacy-email 预览核对 | 统一提示且不泄露账号存在性；绑定需人工脚本+用户确认控制权 | 待填 | 待填 | — |

当前整体邮件链状态：**NOT_RUN（等待用户手动验证）**；mock/捕获型 sender 不得替代。

## 9. 已知问题与开放项

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| K1 | 改密成功后登录页提示曾因 RequireAuth 重定向覆盖 router state 而缺失 | 提示语缺失（安全行为正常） | **FIXED（390f6a4）**：改为一过性内存提示，恰好一次、不复播；独立复核 PASS/APPROVED；本轮 mock e2e 已断言 |
| N1 | Task 6 terminal 撤销竞态分支未结算 LIVE session（复核发现，静态分析无复现） | 可能遗留 LIVE 行/active marker，后续 terminal 409 | **FIXED（fa5ac26 + fcedcc4）**：closeRevoked 走单会话 settleAndClose；确定性 stale-version 测试覆盖 4401、PTY 未开、无 LIVE、INTERRUPTED 恰一次、后续 reserve 成功；fix1 复审 PASS |
| M-a | 终止门非异常安全（CAS 后 send 抛 RuntimeException 可能永久残留 LIVE） | 与 N1 同类后果（异常路径） | **FIXED（b132fb1）**：try/finally 保证 settle/close；throwing fake session 测试；Lead 定向 36/36；最终整分支复核已核（保留多会话异常循环残余 Minor，D5 deferred） |
| M-b/M-c/M-d | Task 6 fix 轮遗留：部分路径回归测试缺口、stale-version 帧序契约未固定、SSE auth.revoked 改为尽力异步的语义说明 | 测试/契约清晰度；不阻断功能 | **ACCEPTABLE-DEFERRED（最终复核已分诊，D5）**：记录在 reviews/task-6-fix1-rereview.md；确认非 Critical/Important |
| B1 | 后端完整 Maven 套件未运行（Maven 与 Task 6 修复轮串行） | 全局 strict Jackson/V18/无关控制器全量回归未验证 | **PASS（Phase B-2）**：1076 tests / 0 failures / 0 errors / 2 skipped，BUILD SUCCESS，39:54，disposable MySQL（2 skipped 为真实集群/清理证据的环境门） |
| P1 (I1) | 实际 backend 镜像 PNG 渲染验证（设计 §5.3）仍 NOT_RUN | 真实部署的 GET /api/v1/auth/captcha 是否能返回可解码 PNG 未验证；本地 JVM headless 测试不能替代 | **NOT_RUN（Docker engine 不可用）**：Task 4 报告明确 NOT_RUN；smoke 步骤见 §6.5/§7，交付前必须补齐 |
| F1 | 前端全量 vitest 非全绿：1 个已知 visual spec + 3 个并发负载 flake（隔离 92/92 PASS） | 不能声称前端全量绿 | 记录为已知/环境性；未改源码 |
| F2 | 精确 `pwsh -NoProfile -File ...` 无法执行（本机无 pwsh） | 两脚本 ps1 证据仅 PS 5.1 | NOT_RUN（环境限制；PS 5.1 等价 PASS） |
| R1 | 复核 deferred minors：T4 N4/N5/N6（N2 已由 af94477 修复）、T5 若干 Minor、T6 M-b/M-c/M-d、T7 M1–M4 | 不阻断本地交付 | **DONE（最终复核分诊）**：均 ACCEPTABLE-DEFERRED（D1–D10）；无未解决 Critical/Important 代码项 |
| R2 | 最终整分支独立复核 | 本地交付质量门 | **DONE（2026-10-30）**：本地分支 **APPROVED**；交付 YES 条件为文档 MUST-FIX **C1/I1/I2**；真实环境 NOT_RUN；**MULTI_ACCOUNT_MVP_PASS 未授予**。记录：本地 `.superpowers/sdd/2026-10-29-multi-account/reviews/final-whole-branch-review.md`（review 记录，不入库） |
| S1 | 真实 SMTP/邮件、集群/部署/Secret、V17+V18 运行库迁移、实际镜像 PNG、两账号/网络/清理、用户验收 | 真实环境验收与 PASS 门 | NOT_RUN（需用户授权；清单见 §7） |
| C1 | 仓库 baseline 预先存在的明文凭据（.claude/settings.local.json、.zcode/config.json、docs/old_docs/.../2026-09-26-python-runtime-review-fix-plan.md；非本分支引入，本 worktree 未修改） | 任何 push/merge/发布前必须轮换并清理历史；本文件不复制任何 secret 值 | **REMINDER / NOT_RUN**：轮换+历史清理未执行（由用户/发布流程处理）；不影响 local 代码 verdict |

## 10. PASS 判定

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
