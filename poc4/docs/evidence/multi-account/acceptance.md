# 多账号与账号生命周期验收记录（Phase A）

- 日期：2026-10-29（Asia/Shanghai）
- 分支：`codex/multi-account`（独立 worktree）
- 本记录状态：**进行中 — 仅 Phase A 本地交付物与本地证据**。
- **`MULTI_ACCOUNT_MVP_PASS` 未授予。** 真实云端、真实邮件、策略 Apply、两账号隔离与
  用户人工验收尚未执行；本地 mock/fixture 通过不等于真实环境验收。

权威设计：[多账户与账号生命周期设计](../../../../docs/superpowers/specs/2026-10-29-multi-account-design.md)；
实施计划：[多账号实施计划](../../../../docs/superpowers/plans/2026-10-29-multi-account-implementation-plan.md)；
任务拆解与各任务报告：`.superpowers/sdd/2026-10-29-multi-account/`。

## 1. 状态口径

| 状态 | 含义 |
| --- | --- |
| PASS | 在标注的环境中实际执行并通过；必须能给出命令/日志/截图/回读等证据来源 |
| FAILED | 实际执行且失败（记录命令、错误与影响） |
| SKIPPED | 明确不适用或按设计跳过（写明原因） |
| NOT_RUN | 尚未执行（写明阻塞/前置条件） |
| NOT_REVERIFIED | 曾被验证过，但当前代码/环境变化后未重新验证 |
| WAIVED_BY_USER | 用户明确豁免 |

测试代码存在、mock 通过、fixture 通过、源码审阅、用户人工验证分别记录，**互不替代**。

## 2. 证据矩阵

列说明：
- **code/local tests**：代码实现与本机自动化测试（可 mock/fixture/捕获型替身）；
- **independent review**：独立复核记录（见 `.superpowers/sdd/2026-10-29-multi-account/reviews/`）；
- **user-manual email verification**：真实 126 邮件由用户手动完成的发送/收件/验证码提交；
- **policy preview+apply**：真实集群上的旧 NetworkPolicy 迁移预览与 Apply；
- **two-account isolation**：真实云端两账号顺序验收与跨账号拒绝；
- **cloud acceptance**：真实公网入口的浏览器/API 验收。

| # | 验收项 | 证据来源 | code/local tests | independent review | user-manual email | policy preview+apply | two-account isolation | cloud acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 依赖 NetworkPolicy 项目级收窄 + 创建顺序 | Task 1 report / `DependencyResourceFactoryTest`、`ProjectDependenciesTest` | PASS（本地 Maven 定向，21/21） | PASS（两轮复审；1 项非阻断 Minor M8 已由 Task 8 修复） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN | NOT_RUN |
| 2 | 旧策略迁移脚本（默认预览、备份、JSON Patch、回读、零遗漏拒绝） | `poc4/deploy/multi-account/repair-dependency-policy.*` | PASS（fixture 16/16，Windows PowerShell 5.1） | PASS（复审 I1–I7/M5/M6/M8 闭环） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN | NOT_RUN |
| 3 | 统一客户端会话终止（expiry/logout/401）+ 迟到响应防护 | Task 2 report / 前端 vitest | PASS（任务报告；本次未复跑） | PASS（fix1/fix2 复审） | SKIPPED（不涉及） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 4 | V17 账号 schema（email/email_verified_at/auth_version，旧账号保留） | Task 3 report / `AccountSchemaTest`、Flyway disposable schema | PASS（任务报告；本次未复跑） | PASS（task-3 复审 + fix1 复审） | SKIPPED（不涉及） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 5 | 图形验证码 + 邮箱验证码挑战（一次性/冷却/重发失效/失败发送） | Task 4 report / 后端测试 | PASS（任务报告；本次未复跑） | PASS（task-4 复审，修复轮见 reviews） | NOT_RUN（用户人工） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 6 | 注册 / 找回 / 改密 HTTP 流程 | Task 5 | NOT_RUN（Task 5 进行中；Phase A 不运行完整后端套件） | NOT_RUN | NOT_RUN（用户人工） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 7 | 改密撤销旧 JWT/ticket/连接，后台任务继续 | Task 6 | NOT_RUN（Task 6 未开始/进行中） | NOT_RUN | SKIPPED（不涉及） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 8 | 三个账号页面 + 客户端撤销信号（WS 4401 / SSE auth.revoked / 一次 /auth/me） | Task 7 report + `reviews/task-7-*` | PASS（任务报告 206/206 定向；本次未复跑） | PASS（task-7 复审 + fix1/fix2 复审） | NOT_RUN（用户人工） | SKIPPED（不涉及） | NOT_RUN | NOT_RUN |
| 9 | 注册/找回/改密三条 mock 浏览器流程 | 本次新 spec `multi-account.spec.ts` | PASS（Playwright mock，4/4 passed，2026-10-29） | NOT_RUN（本任务交付物待 Lead/独立复核） | NOT_RUN（mock 明确不代表真实邮件） | SKIPPED（不涉及） | SKIPPED（mock 单用户状态） | NOT_RUN |
| 10 | 人工邮箱链路：正常注册送达 / 正常找回送达 / 过期码 / 重发旧码失效 / 重复提交拒绝 / 重置后旧密码失效 | 本文件 §4 清单模板 | NOT_RUN（用户手动） | NOT_RUN | **NOT_RUN（等待用户手动验证）** | SKIPPED（不涉及） | SKIPPED（不涉及） | NOT_RUN |
| 11 | 部署配置模板与 Secret 引用（mail/challenge/registration） | `poc4/deploy/multi-account/config.example.env`、`poc4/deploy/6b/backend.yaml` | PASS（本地文件/结构校验，2026-10-29） | NOT_RUN | SKIPPED（不涉及） | SKIPPED（不涉及） | SKIPPED（不涉及） | NOT_RUN（未 Apply、未注入 Secret） |
| 12 | 受控升级：V17 迁移、单 backend Recreate、旧账号/项目回读、旧 JWT 统一重登 | 计划 Task 8 第 3 项 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |
| 13 | 真实策略迁移：完整旧 policy 预览 → 备份 → Apply → 回读 | `repair-dependency-policy.ps1`（真实集群） | 本地 fixture PASS | PASS（复审） | SKIPPED（不涉及） | **NOT_RUN（本任务禁止连接集群/Apply）** | NOT_RUN | NOT_RUN |
| 14 | 两账号顺序验收：登录→创建/编辑/运行/终端/AI→退出，B 再执行；跨账号替换/越权拒绝；每账号 8 项目、第 9 个拒绝 | 本文件 `multi-account-cloud.spec.ts` + 计划 Task 8 第 4 项 | 云端 spec 骨架已就绪（`--list` 5 项通过，未执行） | NOT_RUN | NOT_RUN | NOT_RUN | **NOT_RUN（需用户手动准备两个已验证账号与专用项目）** | NOT_RUN |
| 15 | 网络隔离探测：自身依赖连通、跨项目 Service/Pod IP 拒绝、公开应用匿名正常、workspace/platform 旁路核查 | 计划 Task 8 第 4 项“网络” | NOT_RUN | NOT_RUN | SKIPPED（不涉及） | NOT_RUN | NOT_RUN | NOT_RUN |
| 16 | 结果与清理：精确 owner/project 清理 disposable 资源、保留旧账号项目、无广泛 git clean | 计划 Task 8 第 5 项 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN |

## 3. Phase A 已执行命令与结果（2026-10-29）

环境：Windows；前端 pnpm 10.33.0；Playwright 1.62.1 + chromium 可用；本地 MySQL 8.0.43
（disposable schema 前缀 `manao_stage6%`）；**`pwsh` 二进制不存在**（Windows PowerShell
5.1.26100.7344），因此“精确 pwsh 命令”一律记 NOT_RUN，脚本在 PS 5.1 下执行等价命令。

| 命令 | 结果 |
| --- | --- |
| `powershell -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1` | PASS 16/16，exit 0（含本次新增 patch 负载写入失败统一失败路径场景） |
| `powershell -NoProfile -File poc4/deploy/multi-account/bind-legacy-email.ps1 -SelfTest`（env: MANAO_DB_URL=jdbc:mysql://127.0.0.1:3306/manao_poc4_test，MANAO_DB_USERNAME=manao，MANAO_DB_PASSWORD 空） | PASS 10/10，exit 0；自建 `manao_stage6_t8_<32hex>` schema 并在 finally 中 DROP；未触碰 `manao_poc4` / `manao_poc4_6b` |
| `pnpm exec playwright test --config playwright.multi-account.config.ts`（`poc4/frontend`） | PASS 4/4，exit 0（Vite mock build + preview；MSW 替身；无真实后端/邮件） |
| `pnpm exec playwright test --config playwright.multi-account-cloud.config.ts --list`（`poc4/frontend`） | PASS（收集 5 项；仅列表，未执行真实云端） |
| PyYAML 解析 `poc4/deploy/6b/backend.yaml` | PASS（2 个文档；Deployment env 含 30 项，新增 9 项多账号变量；无重复 env 名） |
| 完整 backend 测试套件（`mvn test`） | **NOT_RUN（Phase A 不运行；后端 Maven 归 Task 5/6 实现者，Phase B 统一执行）** |
| 完整前端 `pnpm test` / typecheck / build | **NOT_RUN（Phase B；本次仅新增 Playwright 配置/spec，mock build 内嵌 typecheck 已通过）** |
| 真实 126 SMTP/IMAP、真实邮件发送/收信 | **NOT_RUN（禁止；需用户手动验证并记录 §4）** |
| 集群只读预览 / 策略 Apply / 部署 / 迁移 | **NOT_RUN（本任务禁止）** |

## 4. 用户人工邮件验证清单（模板，未填写）

> 由用户手动完成；agent 不触发真实邮件、不读取 IMAP、不记录授权码/验证码/密码。
> 每行由用户填写结果（PASS/FAILED）、日期与脱敏备注；不记录任何秘密值。
> 依赖的前置开关：仅在用户授权的验收窗口内临时启用
> `MANAO_MAIL_ENABLED=true` 与 `MANAO_REGISTRATION_ENABLED=true`；验收后恢复 false。

| # | 场景 | 操作步骤（用户） | 预期结果 | 用户结果 | 日期 | 备注（脱敏） |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 正常注册送达 | 打开 /register，输入新用户名/邮箱/密码与图形码，发送邮箱验证码，查收 126 邮件 | 邮件送达；6 位码可提交；注册成功并回到登录页（不自动登录） | 待填 | 待填 | — |
| E2 | 正常找回送达 | 打开 /forgot-password，用已绑定邮箱发送找回码，查收邮件并重置 | 邮件送达；重置成功；新密码可登录，旧密码失效 | 待填 | 待填 | — |
| E3 | 验证码过期 | 取得邮箱码后等待超过 10 分钟再提交 | 提交被拒绝（EMAIL_CODE_INVALID/无效），不创建账号/不重置密码 | 待填 | 待填 | — |
| E4 | 重发使旧码失效 | 发送一次后点击“重新发送”，只使用旧邮件里的码提交 | 旧码被拒绝；新码可用（同一用途/邮箱 60 秒冷却生效） | 待填 | 待填 | — |
| E5 | 重复提交拒绝 | 使用一个已消费的验证码再次提交注册/重置 | 请求被拒绝；不产生第二个账号/第二次重置 | 待填 | 待填 | — |
| E6 | 重置后旧密码失效 | 找回重置成功后，用旧密码登录 | 旧密码登录失败；新密码登录成功；其他旧登录凭据被撤销 | 待填 | 待填 | — |
| E7 | 未绑定邮箱旧账号 | 用 `bind-legacy-email.ps1` 的预览输出（不 Apply）核对：旧账号 email 为 NULL 时不能走找回 | 找回页给出统一提示且不泄露账号存在性；绑定需人工维护脚本 + 用户确认邮箱控制权 | 待填 | 待填 | — |

（邮件链结论只有用户填写 E1–E7 后才可标记；当前整体 **NOT_RUN**，不得用 mock 替代。）

## 5. Phase B 待执行证据（占位）

以下项在 Phase A 均未执行，等待 Lead 确认 Task 5/6 完成并授权后逐项补齐命令、结果与证据落点：

1. 本地完整回归：`pnpm exec playwright test tests/e2e/multi-account.spec.ts --project=chromium`（本次已提前跑通）、`mvn -f poc4/backend/pom.xml test`（disposable MySQL）、`pnpm --dir poc4/frontend test`。
2. 真实邮箱与图形码：实际 backend 镜像渲染 PNG 并验证可解码；邮件链由用户按 §4 手动验收。
3. 受控升级：记录镜像 SHA/digest、单 backend Recreate、注册开关 false、DB 备份点、V17 迁移、旧账号/项目回读、旧 JWT 重登、旧 NULL ticket 拒绝；回滚不 down migrate、不恢复宽 policy。
4. 两账号顺序验收：真实发送等待用户手动完成；随后由获准的云端脚本执行登录→创建/编辑/运行/终端/AI 展示→退出，B 顺序执行；跨账号 ID 替换拒绝；8 项目上限；A 到期→B 登录、迟到响应、改密后旧 JWT/ticket/连接失效且后台任务继续。网络探测按计划执行并保留最小证据。
5. 清理：精确 owner/project 清理 disposable 资源，保留旧账号项目；删除本地临时文件；显式 `git add` 提交；不广泛 `git clean`。

## 6. 已知问题 / 开放项

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| K1 | 改密成功后登录页不显示“密码已更新，请重新登录”提示：`ChangePasswordPage` 在 `clear('logout')` 后 `navigate('/login', { passwordChanged: true })`，但 `RequireAuth` 的匿名重定向把 router state 覆盖为 `{ from: '/account/password' }` | 仅提示语缺失；会话终止、旧密码失效、需重新登录等安全行为已由本次 mock e2e 验证 | **OPEN（本次真实浏览器 mock 运行发现；属 Task 7 前端 src，Task 8 不改前端 src；建议 Task 7 后续最小修复 + 浏览器级回归）** |
| K2 | `pwsh` 二进制不在本机 | 精确 pwsh 命令 NOT_RUN；PS 5.1 等价运行 PASS（脚本兼容 5.1/7） | OPEN（环境限制） |
| K3 | Cloud spec 未准备真实账号/项目/URL | 真实云端验收 NOT_RUN | 等待 Phase B 授权与用户手动准备账号 |
| K4 | Task 5/6 未完成 | 后端完整套件与账号生命周期真实验收未运行 | 等待 Lead 确认后 Phase B |

## 7. PASS 判定

**`MULTI_ACCOUNT_MVP_PASS` 未授予。** 授权条件（按设计与计划）：范围内证据齐全，
即代码/本地测试、独立复核、用户人工邮件验证、策略预览+Apply 回读、两账号隔离与云端验收
全部有真实证据且无未解决 Critical/Important。当前仅完成 Phase A 本地交付物与本地 mock/
fixture 证据；真实邮件、集群与两账号验收均 NOT_RUN。用户尚未完成 §4 时不能以 mock 通过
替代整体 PASS。
