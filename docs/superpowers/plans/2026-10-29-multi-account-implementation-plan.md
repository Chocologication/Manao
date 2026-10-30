# 多账户与账号生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先补强依赖隔离与会话清理，再交付用户名/密码/图形验证码/邮箱验证注册、找回及修改密码，保持每账户8项目。

**Architecture:** 复用 Spring Boot、MySQL、JWT、owner 校验和前端 authSession。仅增加账号服务、挑战存储、薄 SMTP 适配及单 backend 的旧连接撤销器；同一时刻一人使用，不建设调度、计费或新身份平台。

**Tech Stack:** Java 17、Spring Boot 3.5.9、MySQL/Flyway、Fabric8 7.7.0；React/TypeScript、TanStack Query、pnpm、Vitest/Playwright。邮件依赖跟随 Boot BOM。

**Spec:** [多账户设计](../specs/2026-10-29-multi-account-design.md)。实施前必读，产品合同及默认值以设计为准。

## Global Constraints

- 当前只完成规划，下列实现与验证步骤均未执行。
- 基线 `master@35b693e416849ae4d3975bdff5d3e631b0588591`；已经创建 `.worktree/multi-account` / `codex/multi-account`，继续复用，不另从历史 AI 工作树起步。
- Task 1→2优先，其余按3→4→5→6→7→8。Task6撤销闭环完成前不开放注册/改密入口。
- 同时仅一人使用Manao/AI；不增加AI并发/队列、Redis、MQ、outbox、身份微服务、每用户namespace或全局使用者锁。迟到请求、重复提交仍需要边界处理。
- 每账户8个未删除项目，全部状态占名额；不修改现有owner_id。发布应用继续公开。
- 唯一邮箱；不改名/换绑；旧账号email=NULL仍能登录，绑定前不能邮件找回。
- 图形码只用于注册/找回发邮件，登录不需要。改密/重置撤销旧凭据与显示连接，Run/AI继续执行。
- 前端pnpm；UTF-8无BOM；修改前重读，遵守.gitattributes。不提交凭据、验证码或用户原始内容。
- 真MySQL测试仅disposable schema，禁止重置运行库。SMTP非秘密参数已由2026-10-29补充确定；授权码仅通过运行时Secret/受控环境注入，不保存到计划、example、交接提示词或日志。
- 真实验证码发送、收件与提交由用户手动验证；自动化只用测试sender。本次补充不授权实现计划、SMTP登录/发信探测、集群修改、服务启动或业务测试；后续按用户实际发出的实施/发布指令执行，不借用旧阶段授权。

## 2026-10-29邮件补充与交接边界

用户提供的126邮箱已开启IMAP/SMTP服务，截图给出SMTP主机smtp.126.com、IMAP主机imap.126.com和SSL支持。Manao仅使用SMTP发送，不实现IMAP收信或自动读取验证码。发信参数如下；465端口由网易官方帮助补充，来源见设计第7节，未做SMTP连接验证。

```dotenv
MANAO_REGISTRATION_ENABLED=false
MANAO_MAIL_ENABLED=false
MANAO_MAIL_HOST=smtp.126.com
MANAO_MAIL_PORT=465
MANAO_MAIL_USERNAME=shilizhengnanren@126.com
MANAO_MAIL_FROM=shilizhengnanren@126.com
MANAO_MAIL_TLS_MODE=ssl
# 使用客户端授权码，不是网页登录密码；下方保持空值，由运行环境Secret注入。
MANAO_MAIL_PASSWORD=
```

以上仅是规划配置样例，不创建或启用实际环境变量/Secret。SMTP必须认证，采用465隐式TLS并校验证书和主机名，不混用STARTTLS或关闭证书验证；保留有限超时。授权码已由用户在会话中提供，本轮不落盘。接手agent若拿不到安全配置，只暂停真实邮件配置/人工交付环节，不虚构授权码、不通过聊天历史或仓库寻找密钥、不阻塞其余实现。

用户负责手动触发注册/找回验证码发送、收件和提交；agent准备操作步骤、页面错误提示和脱敏结果模板。自动化不调用真实126的发信/登录/收信，不开启启动时SMTP连接测试。未收到用户结果前记录 `NOT_RUN（等待用户手动验证）`；用户反馈后注明“用户手动验证”、日期与场景，不写成agent实测。配置提供不等于送达已验证。

## 基线与职责

实施时在本工作树先执行：

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git diff --check
pnpm --version
java -version
mvn -version
```

CodeGraph当前警告索引来自主checkout；先用CodeGraph定位，涉及修改的内容仍从本工作树核对，不自行重建索引。首次实施需要前端依赖时用 `pnpm --dir poc4/frontend install --frozen-lockfile`，不复制其他工作树node_modules。计划写作不安装依赖或启动服务。

| 单元 | 职责 |
| --- | --- |
| `AuthContracts` | HTTP DTO、AccountIdentity和共用返回类型 |
| `UserStore` / `AuthService` | 用户状态、短事务与注册/登录/密码流程 |
| `AuthChallengeStore` | challenge用途、限次/冷却、一次性消费 |
| `CaptchaService` / `EmailVerificationService` | PNG挑战；邮箱挑战申请与发送状态 |
| `VerificationMailSender` / `SmtpVerificationMailSender` | 一个发码接口与薄SMTP实现 |
| `AuthProperties` | 注册开关、验证码参数、邮件配置 |
| `UserSessionRevoker` | 单backend按user/version撤销旧连接 |
| 三个账号页 + `CaptchaField` | 注册/找回各同页两步；修改密码 |
| `poc4/deploy/multi-account/` | 本专题配置/维护与发布说明 |

每任务执行RED→最小实现→GREEN→定向审查，显式暂存该任务文件再提交；禁止git add .。基础设施连接失败不算业务RED，测试代码存在不等于PASS。命令均从工作树根执行。

## Task 1：依赖策略收窄与旧策略迁移准备

**Files**
- Modify: `poc4/backend/src/main/java/com/manao/poc4/kubernetes/DependencyResourceFactory.java`、`Fabric8ProjectDependencies.java`（同目录）
- Test: `poc4/backend/src/test/java/com/manao/poc4/kubernetes/DependencyResourceFactoryTest.java`
- Test: `poc4/backend/src/test/java/com/manao/poc4/project/ProjectDependenciesTest.java`
- Create: `poc4/deploy/multi-account/repair-dependency-policy.ps1`、`repair-dependency-policy.test.ps1`、`README.md`（同目录）

**Interfaces:** 保留 `dependencyNetworkPolicy(String projectId)` 和 `ensure(String projectId, ProjectRuntimeSpec spec)`。脚本参数为 `-Context -Namespace -ProjectsFile -OutputDirectory [-Apply]`，默认仅预览；ProjectsFile为已核对的 `{ownerId,projectId}` JSON数组。

- [x] **1. RED。** 在现有factory fixture加入两项目目标断言：

```java
var first = factory.dependencyNetworkPolicy("p1");
var second = factory.dependencyNetworkPolicy("p2");
assertThat(first.getSpec().getPodSelector().getMatchLabels())
    .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, "p1");
assertThat(second.getSpec().getPodSelector().getMatchLabels())
    .containsEntry(WorkspaceResourceFactory.LABEL_PROJECT_ID, "p2");
```

同时断言component、来源、端口不变、没有空selector；mock Kubernetes记录创建顺序，要求policy先于workload；无依赖不建policy，重复ensure不改Secret/PVC。

- [x] **2. 运行失败用例。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=DependencyResourceFactoryTest,ProjectDependenciesTest' test
```

- [x] **3. 实现。** 目标LabelSelector增加 `.withMatchLabels(Map.of(WorkspaceResourceFactory.LABEL_PROJECT_ID, projectId))`；在ensure内先创建一次policy再进入依赖分支，删除分支末尾重复调用；保留旧资源身份验证。
- [x] **4. 维护脚本。** 读明确context/namespace与项目清单，检查name/managed-by/project/UID/完整旧spec；namespace内还有清单外广泛策略则报告并拒绝完成，不能偷偷扩大范围。JSON Patch带 `test /metadata/uid`、`test /metadata/resourceVersion`，只替换podSelector；保存无Secret的策略备份并回读。已修复幂等，无归属/未知spec/并发变化停止。fixture测试只读预览、旧/新selector、遗漏/未知策略和版本冲突，不能连接集群。
- [x] **5. GREEN和提交。** 重跑两类测试与 `pwsh -NoProfile -File poc4/deploy/multi-account/repair-dependency-policy.test.ps1`；README写明旧策略叠加、零遗漏与回滚不恢复广泛放行。此处不Apply。提交 `fix: scope dependency network policies to project`。

完成记录：实施 9607b18（Java 21/21 PASS、PS fixture 8/8，PS 5.1；pwsh NOT_RUN 因本机无该二进制）；复查修复 7aacf37（15/15）、e19c938（I7：Apply 改用 OutputDirectory/patch 下的 --patch-file，避免 PS5.1 argv 引号丢失）。独立复核 PASS（残余 Minor：patch 落盘失败未写 FAILED apply-report（已由 Task 8 f39c788 修复并加 fixture））。真实集群预览/Apply 与跨账号隔离仍 NOT_RUN，等待用户授权。

## Task 2：统一会话清理并拒绝迟到缓存回填

**Files**
- Modify: `poc4/frontend/src/features/auth/authSession.ts`、`authSession.test.ts`（同目录）
- Modify: `poc4/frontend/src/app/appRuntime.ts`、`appRuntime.test.ts`（同目录）
- Modify: `poc4/frontend/src/features/projects/projectQueries.ts`、`ProjectsPage.test.tsx`（同目录）

**Interfaces:** `createAuthSession({onBeforeClear?: (previous: AuthenticatedSnapshot, reason: AnonymousReason) => void})`。logout/handleUnauthorized签名不变，统一调用clear；timer仍调用clear('expired')。

- [x] **1. RED。** 沿用现有fake timer，新增：

```typescript
const beforeClear = vi.fn();
const session = createAuthSession({ onBeforeClear: beforeClear });
session.authenticate(timedResponse);
const previous = session.getSnapshot();
vi.setSystemTime(new Date(timedResponse.expiresAt));
vi.runOnlyPendingTimers();
expect(beforeClear).toHaveBeenCalledWith(previous, 'expired');
expect(session.getSnapshot()).toEqual({ status: 'anonymous', reason: 'expired' });
```

runtime测试用同组dirty buffer/terminal/AI流，比较logout/expired/401终态；覆盖重入、一个清理动作抛错、旧timer/401不清新会话。项目创建/核对延迟到B登录或A重登后返回，不能写缓存或invalidate。

- [x] **2. 运行RED。**

```powershell
pnpm --dir poc4/frontend exec vitest run src/features/auth/authSession.test.ts src/app/appRuntime.test.ts src/features/projects/ProjectsPage.test.tsx
```

- [x] **3. 最小实现。** callback在变anonymous前用previous.user.id清IDs、连接、workspace/buffer、store/dialog、QueryClient。各步骤失败不能阻止后续，clear防重入并finally清认证；authenticate替换旧会话前先清理。保留reason文案、手动退出未保存确认，不自动保存/停止后台任务。

```typescript
// useMutation逐请求context，不能用会被下一请求覆盖的组件ref。
onMutate: () => ({ session: authSession.getSnapshot() }),
onSuccess: (created, _variables, context) => {
  if (!context || context.session.status !== 'authenticated'
      || context.session !== authSession.getSnapshot()) return;
  // 此分支内保留原来的setQueryData和invalidate逻辑。
},
```

不撤销服务器可能成功的创建，不自动重发，不重写全站QueryKey。
- [x] **4. GREEN和提交。** 重跑3文件及 `pnpm --dir poc4/frontend typecheck`，git diff --check。提交 `fix: share session cleanup for expiry logout and unauthorized`。（实施 5fe82aa + 复查修复 c310eb1/1714aec；定向测试 104/104 GREEN，typecheck 0，独立复核 PASS。）

## Task 3：账户迁移与JWT版本

**Files**
- Create: `poc4/backend/src/main/resources/db/migration/V17__account_registration_and_recovery.sql`
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/AuthContracts.java`、`UserStore.java`、`AuthProperties.java`（同目录）
- Modify in same auth directory: `JwtService.java`、`JwtAuthenticationFilter.java`、`AuthController.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/SecurityConfig.java`
- Create tests in `poc4/backend/src/test/java/com/manao/poc4/auth/`: `AccountSchemaTest.java`、`UserStoreTest.java`、`JwtAuthenticationFilterTest.java`
- Modify test in same directory: `AuthControllerTest.java`

**Interfaces**
- `AuthContracts.AccountIdentity(String userId,long authVersion)` implements Principal，getName返回userId；userId/version均来自认证，不接受请求体提供owner。
- `UserStore.findById/findByUsername/findVerifiedByEmail(String) -> Optional<UserAccount>`；`isCurrent(AccountIdentity) -> boolean`。UserAccount含id/username/passwordHash/enabled/email/emailVerifiedAt/authVersion，不直接JSON序列化。
- `JwtService.issue(String userId,long authVersion)`；Claims增加authVersion。拒绝无ver、负数、非整数/溢出。

- [x] **1. RED。** `JdbcStoreTestSupport.createAtVersion("16")`插入旧用户/项目后升级：id/owner不变、email NULL/version0，旧密码可新登录；新schema邮箱唯一。新JWT可认证，旧version/缺ver/disabled/用户删除/DB故障均不放行。

```java
String oldToken = jwt.issue(userId, 0).accessToken();
jdbc.update("UPDATE app_user SET auth_version=1 WHERE id=?", userId);
assertThat(users.isCurrent(new AccountIdentity(userId, 0))).isFalse();
// 现有HTTP fixture携oldToken请求 /api/v1/projects，必须401。
```

- [x] **2. RED命令。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AccountSchemaTest,UserStoreTest,JwtAuthenticationFilterTest,AuthControllerTest' test
```

- [x] **3. 最小实现。** V17按设计第6节创建完整challenge结构和两个ticket版本列；不改旧migration。确认V17未被占用。核心用户增量：

```sql
ALTER TABLE app_user
  ADD COLUMN email VARCHAR(254) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN email_verified_at TIMESTAMP(6) NULL,
  ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 0,
  ADD UNIQUE KEY uq_app_user_email(email);
```

Jackson严格解析sub/exp/ver，继续验现有HS256签名/expiry，不扩展手工字段正则；每HTTP查UserStore的enabled/version。原login查询迁到UserStore，签当前version，不加captcha。部署一次性要求旧JWT重登，不加双格式长期兼容；修受影响测试fixture，生产不得保留绕过DB的备用filter构造路径。
- [x] **4. GREEN与提交。** 重跑上述测试和 `ProjectLimitTest,ProjectAuthorizationTest,AgentInternalSecurityTest,AgentLiveOutputHttpTest`；确认旧用户/项目无损。提交 `feat: add verified email identity and versioned access tokens`。

完成记录：实施 181d87d（目标 17/17、回归 19/19、扩展 53/53；V16→V17 保留旧账号/项目）；复查修复 d6a1a20（严格 HTTP JSON、严格 JWT 解析、跨账号 404 证明、升级后旧账号贯通登录）。独立复核 PASS（WARN：全局严格 mapper 对其他控制器的回归已由 Task 8 完整 backend 套件 1076/0/0/2 PASS 排除）。旧 JWT 一次性重登要求已由 ver 校验实现；真实升级部署 NOT_RUN。

## Task 4：图形码、邮箱码与SMTP适配

**Files**
- Create in `poc4/backend/src/main/java/com/manao/poc4/auth/`: `AuthChallengeStore.java`、`CaptchaService.java`、`EmailVerificationService.java`、`VerificationMailSender.java`、`SmtpVerificationMailSender.java`
- Modify in same directory: `AuthProperties.java`、`AuthContracts.java`
- Modify: `poc4/backend/pom.xml`、`poc4/backend/src/main/resources/application.yml`
- Modify only if image rendering needs it: `poc4/backend/Dockerfile`（最小字体/headless依赖）
- Create tests in `poc4/backend/src/test/java/com/manao/poc4/auth/`: `AuthChallengeStoreTest.java`、`CaptchaServiceTest.java`、`EmailVerificationServiceTest.java`、`SmtpVerificationMailSenderTest.java`

**Interfaces**
- `CaptchaService.issue() -> CaptchaResponse(challengeId,imageBase64,expiresAt)`。
- `EmailVerificationService.request(EmailCodeRequest) -> EmailCodeResponse(challengeId,expiresAt,retryAfterSeconds)`；字段见设计第9节。
- `VerificationMailSender.send(String email, EmailPurpose purpose, String code, Instant expiresAt)`，EmailPurpose仅REGISTER_EMAIL/RESET_PASSWORD。
- Store提供 `reserveEmailSend`、`activateSent(id)`、`failSend(id)` 与事务内 `verifyAndConsume`，返回Result以便失败attempt先提交，调用方通过同一TransactionTemplate组合用户写入。

- [x] **1. RED。** 覆盖用途/邮箱不能混用、过期/限次、attempts提交、一次性消费、重发新id旧码失效、冷却/hour cap、图形码用后失效、SENDING不可消费、迟到SMTP回执不能激活新id。注入Clock和随机源替身，答案仅测试fixture可见，不新增生产debug接口。

```sql
SELECT id,purpose,state,attempts,expires_at
FROM auth_challenge WHERE id=? FOR UPDATE;
-- 错误答案持久化attempts并返回INVALID；事务提交后再映射422。
```

找回邮箱不存在/已存在但SMTP失败的状态与响应字段相同，均202；注册SMTP失败503。全局mail未配置对所有邮箱503，先检查配置再查目标用户。
- [x] **2. RED命令。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AuthChallengeStoreTest,CaptchaServiceTest,EmailVerificationServiceTest,SmtpVerificationMailSenderTest' test
```

- [x] **3. 最小实现。** 按设计固定默认生成PNG/HMAC，独立secret；MySQL唯一发送槽保留限流窗口。短事务预留SENDING、事务外发送、同id条件激活/失败；重启残留可在冷却后重新申请，旧码不可用。按小批量清理过期challenge，不扫用户表。

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-mail</artifactId>
</dependency>
```

timeout连接/读/写5000/3000/5000ms；本次部署配置固定smtp.126.com:465/ssl，SMTP用户名和from均为shilizhengnanren@126.com，密码参数实际注入客户端授权码。启用SMTP认证、证书及主机名验证，不明文回退；不为其他邮件provider增加新抽象。缺配置使用unavailable sender而不阻止现有登录启动，发送不自动重试，也不自动开启连接测试。此任务的sender验证只用捕获型替身/本地测试服务，不使用真实126账号。当前JVM和实际backend镜像都需生成可解码PNG；缺字体仅补必要依赖。
- [x] **4. GREEN与提交。** 重跑4类测试，检查没有答案/SMTP凭据日志，验证码无store/URL泄漏。提交 `feat: add one-time image and email verification challenges`。

完成记录：实施 37b65fa，复查修复 fd7da3a、79fb2d8。目标 34/34、Lead 混合回归 113/113（含 V18）、独立复审两轮：Task4 fix PASS（N1 首槽假冷却已由 79fb2d8 闭环；N2 已由 af94477（REQUIRES_NEW）修复；N4/N5/N6 记录待最终分诊）。真实 backend 镜像 PNG、真实 SMTP/邮件 NOT_RUN；V18 为原子配额锁行表（已裁定接受，部署需 V17+V18）。

## Task 5：注册、找回、改密HTTP闭环

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/AuthService.java`
- Modify in same directory: `AuthController.java`、`AuthContracts.java`、`UserStore.java`、`AuthChallengeStore.java`
- Modify: `poc4/backend/src/main/java/com/manao/poc4/config/SecurityConfig.java`
- Create tests in `poc4/backend/src/test/java/com/manao/poc4/auth/`: `AccountLifecycleTest.java`、`AccountHttpContractTest.java`
- Modify test in same directory: `AuthControllerTest.java`

**Interfaces:** `AuthService.register(RegisterRequest) -> RegisteredUser`；`login(LoginRequest) -> LoginResponse`；`resetPassword(PasswordResetRequest)` 与 `changePassword(AccountIdentity,PasswordChangeRequest)` 完成事务。内部使用 `PasswordChangeResult(userId,newAuthVersion)`，Task6接入afterCommit撤销。HTTP字段/路径/状态严格按设计第9节，匿名白名单逐条列举。

- [x] **1. RED HTTP。** 注册前无用户，正确码201无token、随后可登录；username/email冲突409；用途/邮箱错误拒绝；注册关闭同时阻止申请与最终提交。找回存在/不存在同形，旧email NULL不支持找回但可currentPassword改密。

```java
// 用现有MockMvc、disposable MySQL与捕获型测试sender。
mvc.perform(post("/api/v1/auth/password-change")
    .header("Authorization", "Bearer " + currentToken)
    .contentType("application/json")
    .content("{\"currentPassword\":\"wrong\",\"newPassword\":\"new-pass-123\"}"))
    .andExpect(status().isUnprocessableEntity())
    .andExpect(jsonPath("$.code").value("CURRENT_PASSWORD_INVALID"));
```

currentToken由fixture实际用户签发；示例口令仅测试。所有新DTO拒绝未知字段/超长输入，登录不要求captcha。
- [x] **2. RED命令。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=AccountLifecycleTest,AccountHttpContractTest,AuthControllerTest,AuthChallengeStoreTest' test
```

- [x] **3. 最小实现。** Controller保持薄层；注册验证+唯一插入+消费同事务，正确码但username冲突仍可改名后提交；错误attempt不能回滚。找回按签发user/version限定；currentPassword在同一用户版本下校验，密码/hash/version更新原子化。

```sql
UPDATE app_user SET password_hash=?,auth_version=auth_version+1
WHERE id=? AND enabled=TRUE AND auth_version=?;
```

返回0拒绝过时请求，不覆盖新密码；数据库异常仅明确对应唯一索引才映射重复账户，其余保持真实失败。成功204不签发替代token。规范化只作用于新字段/新密码规则，不锁死旧账户登录。
- [x] **4. GREEN与提交。** 重跑4类测试与Task3认证测试；此任务尚缺stream撤销，不能单独开放账号写入口。提交 `feat: implement registration and password recovery endpoints`。

完成记录：实施 9d44ac6（+2fac1a7 测试夹具），Lead 混合回归 113/113 PASS；独立复审 PASS/APPROVED（无 Critical/Important）。复查 Minor（BCrypt 前置成本、409/禁用登录测试、错误响应 no-store、PasswordChangeResult、@Size、expiresAt 形状）已转 T6 轮次的后续小提交处理。真实 HTTP/邮件/SMTP 集成与真实启动仍 NOT_RUN；Task 6 撤销完成前不开放注册/改密入口。

## Task 6：撤销旧票据及连接，后台任务继续

**Files**
- Create: `poc4/backend/src/main/java/com/manao/poc4/auth/UserSessionRevoker.java`；Modify同目录 `AuthService.java`
- Modify in `poc4/backend/src/main/java/com/manao/poc4/log/`: `LogTicketService.java`、`JdbcLogStore.java`、`RunLogController.java`、`RunLogWebSocketHandler.java`
- Modify in `poc4/backend/src/main/java/com/manao/poc4/terminal/`: `TerminalStore.java`、`JdbcTerminalStore.java`、`TerminalSessionService.java`、`TerminalController.java`、`TerminalWebSocketHandler.java`
- Modify in `poc4/backend/src/main/java/com/manao/poc4/ai/`: `AgentLiveOutputController.java`、`AgentLiveOutput.java`
- Modify in `poc4/backend/src/main/java/com/manao/poc4/config/`: `WebSocketConfig.java`、`WorkspaceConfig.java`、`AiConfig.java`
- Create tests in `poc4/backend/src/test/java/com/manao/poc4/auth/`: `UserSessionRevokerTest.java`、`CredentialRevocationTest.java`
- Modify backend tests: `log/LogTicketServiceTest.java`、`log/RunLogWebSocketTest.java`、`terminal/TerminalSessionServiceTest.java`、`terminal/TerminalWebSocketTest.java`、`ai/AgentLiveOutputHttpTest.java`（相对 `poc4/backend/src/test/java/com/manao/poc4/`）

**Interfaces:** `register(userId,version,Runnable) -> Registration`、`closeOlder(userId,newVersion)`；Registration注销幂等。ticket绑定请求原AccountIdentity；SSE subscribe接收认证身份。客户端固定信号WS4401、SSE `auth.revoked`，无用户数据payload。

- [x] **1. RED竞态。** latch覆盖签发中改密、consume后登记前改密、登记后handle/listener安装前改密、SSE等待发送时改密；afterCommit才关闭旧版本，回滚不关，新版本不误关。

```java
var closeOld = new java.util.concurrent.atomic.AtomicInteger();
var closeNew = new java.util.concurrent.atomic.AtomicInteger();
revoker.register("u", 0, closeOld::incrementAndGet);
revoker.register("u", 1, closeNew::incrementAndGet);
revoker.closeOlder("u", 1);
assertThat(closeOld).hasValue(1);
assertThat(closeNew).hasValue(0);
```

晚到PTY handle立即关闭，terminal仅settle一次；已consume尚未open也要结算；Run/AI/持久历史不变。
- [x] **2. RED命令。**

```powershell
mvn -f poc4/backend/pom.xml '-Dtest=UserSessionRevokerTest,CredentialRevocationTest,LogTicketServiceTest,RunLogWebSocketTest,TerminalSessionServiceTest,TerminalWebSocketTest,AgentLiveOutputHttpTest' test
```

- [x] **3. 最小实现。** 签发版本必须来自原请求，不能把旧JWT提升成新version；原子签发/消费JOIN用户版本。连接登记前后fresh DB校验，注册与撤销共用短锁和版本水位；回调锁外逐个处理。handler原子closed与handle安装同步，迟到handle/listener不复活。密码提交后关旧版本，回调失败不谎报密码没改，不回滚已提交密码。

```sql
UPDATE log_ticket t JOIN app_user u ON u.id=t.user_id
SET t.consumed_at=?
WHERE t.ticket_hash=? AND t.consumed_at IS NULL AND t.expires_at>?
  AND u.enabled=TRUE AND t.auth_version=u.auth_version;
```

terminal同条件转LIVE；旧RESERVED转合法EXPIRED释放唯一约束。日志移listener不停止采集；终端复用单会话settleAndClose而非Run stop；SSE只detach旧subscription，不全局shutdown或AI close。依赖注入不得形成Auth↔AI/WS循环。已到网络缓冲的数据不承诺撤回，阻塞连接按现有期限收尾。
- [x] **4. GREEN与提交。** 重跑7类及Task5测试，明确Run/AI状态保持。提交 `feat: revoke old credentials and streams on password changes`。

完成记录：实施 9c65719，复查修复 af94477、fa5ac26、fcedcc4、b132fb1。Task6 7 类 58/58、组合回归 113/113 PASS（Lead 复核 112→113）；独立复核 PASS（N1 terminal 竞态结算已修，M-a 异常安全已由 b132fb1 闭环；残余 M-b/M-c/M-d 记录最终分诊）。撤销仅本进程单 backend；真实多节点/集群 NOT_RUN。

## Task 7：三个账号页面与客户端撤销信号

**Files**
- Create in `poc4/frontend/src/features/auth/`: `RegisterPage.tsx`、`ForgotPasswordPage.tsx`、`ChangePasswordPage.tsx`、`CaptchaField.tsx` 及各自同名 `.test.tsx`
- Modify: `poc4/frontend/src/contracts/auth.ts`、`poc4/frontend/src/api/authApi.ts`
- Modify: `poc4/frontend/src/features/auth/LoginPage.tsx`、`LoginPage.test.tsx`（同目录）
- Modify: `poc4/frontend/src/components/shell/AccountPanel.tsx`、`AccountPanel.test.tsx`（同目录）
- Modify in `poc4/frontend/src/app/`: `AppRouter.tsx`、`appRuntime.ts`、`appRuntime.test.ts`
- Modify in `poc4/frontend/src/mocks/`: `handlers.ts`、`state.ts`、`handlers.test.ts`
- Modify in `poc4/frontend/src/features/logs/`: `RunLogTransport.ts`、`RunLogTransport.test.ts`
- Modify in `poc4/frontend/src/features/terminal/`: `JobTerminalTransport.ts`、`JobTerminalTransport.test.ts`
- Modify in `poc4/frontend/src/features/ai/`: `agentLiveOutput.ts`、`agentLiveOutput.test.ts`、`useAgentLiveOutput.ts`、`useAgentLiveOutput.test.tsx`
- If required by existing terminal layering: `poc4/frontend/src/terminal/WebSocketTerminalTransport.ts`及同名测试

**Interfaces**
- authApi导出 `getAuthOptions/getCaptcha/requestEmailCode/register/resetPassword/changePassword/getMe`，参数/响应类型严格对齐设计第9节。
- CaptchaField管理challengeId+image，外部输入答案；刷新清空答案，不包含任何正确答案数据。
- `handleSessionRevoked(expectedSnapshot)` 仅在仍为原认证snapshot时统一clear。改密提交成功与异常结束后getMe同样使用原snapshot保护。

- [x] **1. RED页面。** 注册两步成功到login，username冲突可保留有效码重填，email变动清旧challenge，刷新不保留密码/码，冷却禁重发；注册关闭/mail未配置有明确状态。找回未知/失败发送同形提示，错误码不登录；旧email NULL提示不能邮箱找回。改密currentPassword错误422不退出，成功统一清理。LoginPage无图形码、无演示密码提示。

```typescript
// 使用现有页面Testing Library harness验证可见行为。
expect(screen.queryByLabelText('图形验证码')).not.toBeInTheDocument(); // LoginPage
expect(screen.getByRole('link', { name: '注册账号' })).toBeVisible();
// A改密请求pending -> logout -> B登录 -> A迟到204，B仍authenticated。
```

transport测试包含WS4401、SSE auth.revoked、异常结束的一次me校验、旧流/迟到me不会清新会话、网络失败不无限重连。
- [x] **2. RED命令。**

```powershell
pnpm --dir poc4/frontend exec vitest run src/features/auth src/app/appRuntime.test.ts src/components/shell/AccountPanel.test.tsx src/features/logs/RunLogTransport.test.ts src/features/terminal/JobTerminalTransport.test.ts src/features/ai/agentLiveOutput.test.ts src/features/ai/useAgentLiveOutput.test.tsx
```

- [x] **3. 最小实现。** 仅 `/register`、`/forgot-password`、`/account/password` 三路由；每页同内两步，复用视觉与表单，不重做工作台。发码及提交禁重复点击，敏感输入只在组件内存；验证码不进URL/storage。公开auth业务422不误触401；注册开关由options显示、后端最终裁决。

```typescript
export function handleSessionRevoked(expected: AuthSnapshot): void {
  if (expected.status === 'authenticated' && authSession.getSnapshot() === expected) {
    authSession.clear('unauthorized');
  }
}
```

改密成功也捕获并比较原snapshot，可使用logout reason展示成功，但绝不能无条件logout新账号。客户端流只处理建立时snapshot；SSE无撤销事件异常结束，做一次getMe，401才清理，网络故障仅显示断开。普通logout无需新增服务端logout接口。
- [x] **4. GREEN和生产边界。** 重跑定向测试与Task2项目测试：

完成记录：实施 4fac593，复查修复 333aadf、28fb5d5，K1 修复 390f6a4。定向 12 文件 209/209、mock Playwright 4/4、typecheck/build/boundary PASS；独立复核（前两轮 codex 审查、K1 由 DSH reviewer 队友复审）。真实后端/SMTP/邮件链路 NOT_RUN（用户手动验收）；MSW 图形码/邮箱码为测试替身；legacy transport options 保留为已记录债务。

```powershell
pnpm --dir poc4/frontend typecheck
pnpm --dir poc4/frontend build
pnpm --dir poc4/frontend test:boundary
```

若mock构建污染dist，最后必须生产build再boundary；生产不得包含获取测试验证码入口。提交 `feat: add verified account registration and recovery UI`。

## Task 8：定向验收与发布维护

**Files**
- Create: `poc4/frontend/tests/e2e/multi-account.spec.ts`（mock）
- Create: `poc4/frontend/tests/e2e/multi-account-cloud.spec.ts`（真实云端独立配置）
- Create: `poc4/frontend/playwright.multi-account.config.ts`
- Create: `poc4/deploy/multi-account/config.example.env`、`bind-legacy-email.ps1`（同目录）
- Modify: `poc4/deploy/multi-account/README.md`及Task1迁移脚本（仅验证发现的必要修正）
- Modify: `poc4/deploy/6b/backend.yaml`（Secret/env引用，不能写实际值）
- Create: `poc4/docs/evidence/multi-account/acceptance.md`
- Modify after actual delivery: `docs/what-we-have-done.md`、`docs/README.md`，仅摘要和入口

**Interfaces**
- 旧账户维护 `bind-legacy-email.ps1 -UserId -ExpectedUsername -Email [-Apply]`，默认预览；数据库连接使用受控环境和参数化SQL，不命令行传密码。要求email NULL、操作者确认邮箱控制权，条件更新不覆盖现有绑定；无公网管理接口。
- cloud Playwright配置真实baseURL、workers=1、无MSW、无自动服务启动；使用用户手动完成邮件注册/验证后提供的专用测试账号，两个用户顺序使用。云端脚本不得自动申请真实邮箱码、连接IMAP取码或增加验证码绕过口；邮件链路与后续账号隔离验收分别记录。

- [x] **1. 本地浏览器及相关完整回归。**

```powershell
pnpm --dir poc4/frontend exec playwright test tests/e2e/multi-account.spec.ts --project=chromium
mvn -f poc4/backend/pom.xml test
pnpm --dir poc4/frontend test
```

完整backend套件仅disposable测试配置；外部依赖不齐如实标NOT_RUN/失败，不把--list当通过。通过后不无理由重复全套。
- [x] **2. 邮件与镜像配置（本地配置部分；实际 backend 镜像 PNG 冒烟已于 2026-10-30 部署后 PASS，见 acceptance §10.4）。** example写入本计划补充块中的已知非秘密参数，MANAO_MAIL_PASSWORD始终留空并说明使用客户端授权码；运行时Secret注入需在获准配置时完成，不回显、不写入仓库。初始发布默认 false；用户完成人工 E1–E6 验收后，2026-10-30 已按用户决定在 6B 清单中正式启用两项（acceptance §12.1），MAIL_PASSWORD 仍仅来自 Secret；agent 不执行真实发送或 SMTP 登录探测。交付人工清单：正常注册送达、找回送达、验证码过期、重发使旧码失效、重复提交拒绝、重置后旧密码失效。用户未验收时邮件链NOT_RUN，不阻塞Task1/2独立修复。实际backend镜像生成PNG并验证可解码；缺字体只补必要依赖。
- [x] **3. 受控升级。**（2026-10-30 用户授权后已执行：6B 单 backend Recreate + 前端滚动、V16→V18 迁移、旧策略预览+Apply+回读、部署前 DB 备份；证据见 acceptance §10） 记录SHA/digest；单backend Recreate、注册false。保留DB恢复点和策略备份，应用V17并核对旧账号/项目；预览完整旧policy清单后才Apply并回读。新登录使用version，旧JWT统一重登，旧NULL票据拒绝。回滚不down migrate或恢复广泛policy；关闭新账号入口时仍保留认证撤销和隔离修复，不能回退到忽略version的旧镜像并声称撤销有效。
- [ ] **4. 两账号顺序验收（PARTIAL；整体 MVP_PASS 未授予）。** 注册/找回的真实发送、收件和验证码提交先由用户手动完成；记录用户反馈后，获准的云端脚本使用准备好的账号做后续登录→创建/编辑/运行/终端/AI展示→退出，B再顺序执行，不代替用户触发真实邮件。替换对方项目/文件/Run/ticket/conversation/task ID必须拒绝。各账户8项目，第9个拒绝；复用专用项目避免重复创建。覆盖A自然到期→B登录、旧响应迟到、改密后旧JWT/ticket/连接失效且后台任务继续、注册开关与旧账号绑定；找回重置链的真实邮件部分仍由用户手动验证，其余撤销行为可自动化验证。（实际：cloud spec 2 passed/3 显式 skip；隔离、8 项目上限、改密撤销、跨账号文件/Run/log-ticket/conversation/agent-task 拒绝均 PASS；终端 PTY/AI 端到端/自然到期/后台继续的云端证据未重造，E7 NOT_RUN，因此整体 MVP_PASS 未授予，边界见 acceptance §12.4/§12.6。）

网络：自身依赖连通、跨项目Service/Pod IP连接拒绝、公开应用匿名正常；补探workspace/platform是否存在跨账户读写旁路。发现可访问旁路则停止开放注册并保留最小证据，提出最小修复，不把计划当全网改造授权。
- [x] **5. 结果与清理（本地证据与 disposable 清理完成；真实 owner/project 运行资源清理已于 2026-10-30 执行，K8s 回读见 acceptance §12.4）。** acceptance分别列代码/mock/用户手动邮件验证/策略迁移/流量/账号隔离/用户验收，写明证据来源。只有范围内证据齐全才能授予 `MULTI_ACCOUNT_MVP_PASS`；等待用户邮件验收时可交付本地实现，但整体PASS仍未授予，不能由mock替代。精确owner/project清理disposable资源，保留旧账号项目；清理不再使用的本地临时文件，禁止广泛git clean。按文件显式提交，合并/推送遵从用户后续指令。

完成记录（本地交付范围）：Task8 Phase A f39c788（config.example.env、bind-legacy-email.ps1 + SelfTest 10/10、M8 修复 16/16、6b/backend.yaml Secret/env 引用、mock/cloud e2e 脚手架）；Phase B f453be8/cf0e381（acceptance.md 22 行矩阵、docs 摘要）。本地证据：完整 backend 1076/0/0/2 skipped PASS（39:54，disposable MySQL）；frontend 完整 1736 tests 4 failed（既有 visual spec + 3 个并行负载 flake，隔离 92/92 PASS）；targeted 209/209、adjacent 414/414、typecheck/build/dist-scan/boundary PASS；mock Playwright 4/4（含 K1 提示断言）。真实环境步骤 2/3/4/5 中的邮件发送、集群旧策略预览/Apply、V17+V18 真实迁移、云端两账号与隔离、Secret 注入、bind-legacy-email -Apply 均 NOT_RUN，等待用户授权；MULTI_ACCOUNT_MVP_PASS 未授予。

最终 whole-branch 复审（DSH reviewer 队友，非 codex/Astra）：本地分支 APPROVED，可作 LOCAL implementation 交付；当时 MULTI_ACCOUNT_MVP_PASS 未授予（后续正式转态与 delta 复核见本节末尾；acceptance §12.6 维持 MVP_PASS 未授予）。

2026-10-30 真实环境执行记录（用户授权“发布到集群并进行下一步工作”）：旧策略预览/Apply/回读 PASS（2 条收窄，幂等复检）；backend/frontend 镜像构建推送并部署（digest 见 acceptance §10）；V16→V18 迁移 PASS；部署后 smoke（options/captcha PNG/JWT ver 校验/旧项目回读/浏览器页面）PASS；依赖跨项目隔离探测 自身 OPEN、跨项目 BLOCKED；MAIL_PASSWORD 未注入、mail/registration 仍 false；真实 126 邮件人工 E1–E7 与云端两账号顺序验收仍 NOT_RUN。复审 MUST-FIX：C1 基线已提交的明文凭据（.claude/settings.local.json、.zcode/config.json、old_docs 计划）非本分支引入，任何 push/merge/发布前必须轮换并清理历史；I1 实际 backend 镜像 PNG 渲染 NOT_RUN；I2 本文件与 acceptance 状态已刷新。

2026-10-30 22:00–22:30 正式转态与验收更新（用户完成 E1–E6 后要求转正式部署）：
- 代码/配置：f8f39ec 邮件文案改"有效期 10 分钟内"（定向测试 PASS）；3a10a9f 6B 清单与模板正式启用 registration/mail（MAIL_PASSWORD 仍仅 Secret）、部署/构建文档更新；1f53e50 Dockerfile 注释明确产品构建必须 VITE_ENABLE_AI=true。
- 镜像/部署：backend `d560ec2a…`、frontend `74c58830…`（VITE_ENABLE_AI=true，修复 AI 入口被编译掉），digest 固定部署成功；Flyway validated 18；options {registrationEnabled:true,emailAvailable:true}。
- 验收：用户人工邮件 E1–E6 PASS（E7 NOT_RUN，用户未执行/未豁免）；cloud spec 2 passed/3 显式 skip；云端两账号隔离、8 项目上限（第 9 个 409 PROJECT_LIMIT_REACHED，7 个清理 204）、改密撤销（旧 JWT 401/旧密码 401/还原 200）、跨账号文件/Run/log-ticket/conversation/agent-task 拒绝（404/401）、公开应用匿名 200（Hello from Manao，停止后不可达）PASS；C1 用户口头确认已轮换，但历史 scrub 未完成，push/merge/publish 继续禁止。
- 边界：本地 kubectl 隧道曾中断，后以经证书校验的直连恢复并保存 `postdeploy-*` 部署/清理回读证据；未重造终端 PTY/AI 端到端/自然到期/后台继续的云端长任务证据；前端全量 vitest 的既有 1 visual spec + 3 flake 保留原状；无 push/merge master 授权。
- **MULTI_ACCOUNT_MVP_PASS 未授予（2026-10-30；独立 delta 复核经 4 轮后 APPROVED，但仍维持未授予判断）**；详细证据与边界以 acceptance §12.6/§12.8 为准。

## 自检与交接

- [x] 设计每项要求能对应任务；Task1/2优先，Task6前不开放账号写入口。
- [x] DTO、枚举、路径一致，无额外verify-email/resume路由。
- [x] sender非秘密配置已补齐；授权码只在获准时注入运行环境，实际启用与用户手动验收仍未执行。
- [x] 当前工作树正确，master和其他工作树保持原状。
- [x] 单人使用仅简化容量，不取消owner、网络和异步会话边界。

2026-10-29已完成规划自检及前端/账号合同的独立静态审查，已修正找回SMTP失败的显式邮箱枚举与改密迟到响应误退新会话两个合同问题。以上勾选只表示文档已核对，不表示Task1–8已实施或测试通过。

2026-10-29邮件补充仅更新设计/计划，未授权或执行实现、Secret配置、真实发信与集群部署。邮件验证码链由用户手动验证的要求优先于较早的自动验收措辞。

用户后续明确启动实施后，第一个动作是Task1新增失败回归。当前未实施上述步骤，邮件及真实集群验收仍需对应执行阶段。
