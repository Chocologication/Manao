# 多账户与账号生命周期设计

状态：设计已整理；用户范围已确认。当前只完成规划，未实施、未部署、未执行业务测试。

## 1. 目标与已确认范围

让少量已知用户能够注册、验证邮箱、登录、找回和修改密码，顺序使用各自的项目。代码、数据、终端和 AI 会话私有，发布的应用仍允许公开访问。

- 本次规划基线：master `35b693e416849ae4d3975bdff5d3e631b0588591`。
- 本次工作树：仓库 `.worktree/multi-account`，分支 `codex/multi-account`；实施时核对本分支，不另从历史 AI 工作树开始。
- 先修复依赖 NetworkPolicy 的目标范围，再统一自然过期、手动退出和 401 的客户端清理。
- 同一时刻只有一个人使用 Manao，AI 同理；不增加排队、多 Worker、公平调度、计费或全局使用者锁。此使用约定不代表已存在的其他用户资源可以互访，也不消除迟到请求和重复提交。
- 每个账户最多 8 个未删除项目；沿用全部状态占名额的当前语义。
- 新账户必须有唯一用户名、密码和唯一已验证邮箱；首版不改用户名、不换绑邮箱。
- 图形验证码仅用于注册和找回密码的邮件验证码申请；登录不增加图形验证码。最终提交邮箱验证码时不重复要求图形验证码。
- 现有账号和项目原样保留，允许邮箱为空，后续通过受控维护流程人工绑定；绑定前不能邮件找回。
- 不增加邀请码；提供可关闭注册的配置开关，关闭注册不影响登录、找回和修改密码。
- 改密或重置成功后使该账号所有旧登录凭据失效，并关闭旧终端、日志和 AI 显示连接；后台应用与 AI 任务继续执行。
- 2026-10-29用户补充发信邮箱 shilizhengnanren@126.com；采用SMTP客户端授权码认证，配置见第7节。授权码仅在后续获准配置时由Secret/受控环境注入，不写入仓库、计划、交接提示词或日志。
- 真实验证码发送、收件与提交流程由用户手动验证。此补充仅更新计划，不授权实现、SMTP登录/发信探测或部署；agent不自动读取邮箱或发送测试验证码。

## 2. 从第一性原理确定最小结构

账户解决“谁在使用”；owner 校验解决“能操作哪些资源”；验证码证明邮箱控制权；密码更新必须同时撤销旧访问权。这四件事复用现有 Spring Boot + MySQL + JWT + 前端 authSession，不引入身份平台、微服务、Redis、消息队列或通用权限框架。

采用一个账号服务、一个用户存储、一个验证码存储和薄邮件适配器。图形码与邮箱码共用一次性挑战存储，只保留本次真正需要的三种用途。前端注册和找回各用一页内的两个步骤，不增加单独的验证中心。

实施顺序为：隔离修补 → 客户端会话清理 → 账号/验证码/密码合同 → 页面与联调 → 定向部署和验收。发信参数已明确，运行环境中的Secret注入与启用尚未执行；它们不阻塞前两项或本地替身验证。真实邮箱流程交用户手动验证，替身成功不能授予真实邮箱 PASS。

## 3. 已核实的复用点与修复点

| 位置 | 现状 | 本次处理 |
| --- | --- | --- |
| `AuthController` / `PasswordService` | JDBC 用户登录、BCrypt cost 12 | 复用密码算法；账号事务集中到 `AuthService` |
| `ProjectService` / `ProjectLimits` | owner 过滤、用户行锁、8 项目 | 保留并回归 |
| `DependencyResourceFactory` | 策略目标缺少 project-id | 目标和来源同时限定项目 |
| `Fabric8ProjectDependencies` | 已有资源只验标签后复用 | 定点迁移旧策略，不靠发布代码自动修复 |
| `authSession` / `appRuntime` | 自然过期绕过完整清理 | 三个出口共用同一清理回调 |
| `projectQueries` | 迟到创建结果可写全局缓存 | 逐请求认证快照校验，阻止跨会话回填 |
| `JwtAuthenticationFilter` | 只验 JWT，不验用户版本 | 校验用户 enabled 与 auth_version |
| log/terminal ticket、WS、AI SSE | ticket 和已连接流不随密码失效 | 版本绑定与本进程定向断连 |

## 4. 先完成两项基础修复

### 4.1 依赖服务隔离

`dependencyNetworkPolicy(projectId).spec.podSelector` 同时包含本项目 label 与 `component In(mysql,redis)`；ingress 来源仍为本项目 Pod，端口仍为 3306/6379。先创建策略，再创建该项目依赖 workload；不改变 Secret、PVC、Service、端口或公开应用合同。

现有策略必须单独迁移：所有平台旧广泛 selector 都要收窄，新增窄策略不能抵消旧策略的放行。维护脚本默认只读预览，使用明确 context、namespace 和已核对的 owner/project 清单；验证 name、managed-by、project label、UID 与预期旧 spec，带 UID/resourceVersion 前置条件仅 patch podSelector，回读复核。未知资源或遗漏旧策略时不能宣称迁移完成。若所选范围外仍有旧策略，报告它并停止完成判定，不擅自扩展清单。备份只保存策略，不保存 Secret。无需扩大 backend RBAC，不做全局自动修复器。

真实验证需同时保留两个账号的项目资源，用户操作顺序执行即可：自身 MySQL/Redis 正常；跨项目 Service 与 Pod IP 端口不能建立连接；“连接成功但密码错误”不算网络隔离。公开应用仍可匿名访问。仓库中的 development-build egress 不能证明普通 Run/workspace 全面隔离；验收同时定向检查跨账户 workspace 与平台内部端点的权限拒绝，若发现可读写的旁路则停止多账户验收，并把最小所需修复提交用户决定，不默认重建网络架构。

### 4.2 一条客户端会话终止路径

自然到期复用手动退出实际执行的清理，而不是模拟按钮点击：

```typescript
type AuthenticatedSnapshot = Extract<AuthSnapshot, { status: 'authenticated' }>;
type AuthSessionOptions = {
  onBeforeClear?: (previous: AuthenticatedSnapshot, reason: AnonymousReason) => void;
};
// createAuthSession(options) 的 clear() 统一触发回调；appRuntime 提供回调。
// logout() -> clear('logout'); timer -> clear('expired'); 401 -> clear('unauthorized').
```

回调按原用户身份清 operation/task IDs，关闭连接，dispose workspace/models/buffers，reset store/dialog，clear QueryClient；之后才发出 anonymous 状态。防止重入，重复 clear 不重做，某个 disposer 失败不能阻止其他清理与认证清空。保留各 reason 文案；手动退出前已有的未保存确认保留，自然到期不等待用户确认，也不自动保存。前端退出不向后台发 Run stop 或 AI pause。

authenticate 接受新会话前若仍有旧 authenticated 状态，先结束旧状态。创建/核对项目请求在发起时捕获认证 snapshot 对象，成功回调仅在仍是同一对象时更新缓存；涵盖同账号重新登录、A→B、旧请求迟到。既有旧 token 401 保护保留。不引入新 session store，也不做全站 QueryKey 重写。

## 5. 用户流程与默认规则

### 5.1 注册

在 `/register` 同页输入用户名、邮箱、密码及图形验证码 → 申请注册邮箱码 → 输入邮箱码并提交注册 → 成功后进入登录页。邮箱验证成功与创建账号在一次事务中完成；此前不插入未验证 app_user，不提前占用用户名，也不自动创建项目或自动登录。发送阶段不传密码，浏览器密码只留当前组件内存，刷新后重新输入。

### 5.2 找回与修改

`/forgot-password` 输入邮箱与图形码 → 申请找回邮箱码 → 同页输入邮箱码、新密码 → 重置后回到登录页。未知邮箱返回相同的“若该邮箱已绑定账号，将收到验证码”响应，不泄露账户是否存在；仅向已绑定且 verified、enabled 的账号发信。邮件不包含明文密码。

登录后的 `/account/password` 要求当前密码、新密码与前端确认输入；不额外要求邮件或图形码。成功后仅当仍是请求发起时的认证 snapshot 才统一退出并提示重新登录；A 的迟到成功响应不能退出已经登录的 B。当前密码错误为 422 `CURRENT_PASSWORD_INVALID`，不误触全局 401 退出；旧凭据本身无效仍是 401。邮箱为空的旧账号也能凭当前密码改密。

### 5.3 工程默认值

以下为本计划选择的简单默认，不是额外待定产品需求：

- 新用户名使用 3–32 位小写 ASCII 字母、数字、下划线，前后空白 trim，输入大写统一小写；冲突同时检查既有用户名的大小写等价形式，不能改写旧账号。旧登录输入合同保留。
- 邮箱 trim 后按 `Locale.ROOT` 转小写，长度不超过 254，经邮箱格式校验；以此值唯一识别，不删除点、不剥离 `+tag`。
- 新设密码 8–64 字符，UTF-8 字节数不超过 72，不 trim、不强制复杂字符组合；前端确认一致，后端执行同一限制。历史登录和 currentPassword 不应用新最短长度，避免锁死旧用户。
- 图形码为 5 位去除易混淆字符的字母数字 PNG，2 分钟有效、最多 5 次验证、成功一次消费。只返回图片与随机 challengeId，禁止把答案写进 SVG/DOM/响应/日志。用 JDK 图像能力；必须验证实际 backend 镜像字体/headless 渲染，无需引入验证码 SaaS。
- 邮箱码 6 位数字，10 分钟有效、最多 5 次错误；同用途同邮箱 60 秒冷却、每小时最多 5 次申请，失败发送也计入冷却。重发生成新 id 和码，旧码失效。
- 单 backend 下图形码生成按 remote address 简单限速 10 次/分钟，当前有效挑战总数最多 1000；只信任经过已配置代理处理后的来源，不直接信任任意 X-Forwarded-For。单机有界计数即可，不引入 Redis；重启清计数的限制在小范围使用中接受。

## 6. 数据与验证码事务

新增 Flyway `V17__account_registration_and_recovery.sql`（实施前核对版本占用）：

- `app_user.email VARCHAR(254) NULL`，规范化后存储，唯一索引，使用明确二进制比较；`email_verified_at TIMESTAMP(6) NULL`；`auth_version BIGINT NOT NULL DEFAULT 0`。NULL 允许多个旧账户，不回填假邮箱、不修改现有 id/owner_id。
- `auth_challenge`：`id`（128-bit 以上随机）、`purpose`（CAPTCHA / REGISTER_EMAIL / RESET_PASSWORD）、可空 `email`、可空 `user_id`、可空 `auth_version_snapshot`、`answer_mac`、`state`（SENDING / ACTIVE / CONSUMED / FAILED）、`expires_at`、`attempts`、`next_send_at`、`window_started_at`、`window_send_count`、`created_at`、`updated_at`。`UNIQUE(purpose,email)` 保留每用途每邮箱一个发送槽；CAPTCHA 的 email 为 NULL。重发锁定槽，替换 id/码和当前状态，保留小时限流计数。
- `log_ticket.auth_version`、`terminal_session.auth_version` 可空。旧票据 NULL 拒绝消费；旧 RESERVED 行用现有合法 EXPIRED 状态释放占用，不删除运行记录。新票据总带发起请求的认证版本。

短码只存 `HMAC-SHA256(MANAO_AUTH_CHALLENGE_SECRET, id|purpose|email|answer)`，使用随机源与恒定时间比较；独立服务端 secret 不进仓库。

验证码校验以行锁或条件更新实现限次和一次消费。错误尝试返回明确结果，事务提交后再映射 ApiException，避免异常回滚掉 attempts。正确的注册码校验、唯一用户插入与消费同事务；用户名冲突保留尚未消费的有效邮箱码供用户改名再提交。邮箱已占用不能创建第二个账号。重置码绑定 user_id 和签发时 auth_version；任何后续改密都使旧重置码失效。

验证码表不需要后台工作流：按请求顺带做小批量过期清理，邮箱发送槽在小时窗口结束且挑战终态/过期后可删；不得删除仍在 SENDING 的有效操作。图形码总量限制与过期清理必须有测试。

## 7. 邮件发送边界

依赖只增加 Boot 管理版本的 `spring-boot-starter-mail`；使用薄 `VerificationMailSender`，生产实现调用 `JavaMailSender`，测试实现只向测试 fixture 暴露捕获消息，不提供生产获取验证码接口。

图形码验证/消费与邮件槽 SENDING 预留在短事务完成 → 事务外同步发送 → 条件更新同一个 id 为 ACTIVE。SMTP 错误或超时设 FAILED，不可消费，不自动重发；注册发码可返回 `MAIL_SEND_FAILED`，找回发码无论邮箱是否绑定、此次SMTP是否成功都返回同形202，失败只记录固定内部结果，不能通过状态码区分邮箱。SMTP 可能已接受邮件但响应丢失，迟到邮件中的无效码允许用户重新申请，不谎称“绝未发送”。未知找回邮箱走相同冷却和有界挑战，不实际发邮件。此设计隐藏显式业务结果，不宣称同步SMTP已经消除了全部响应时序侧信道；小范围首版不增加异步队列来伪造这种保证。

显式 connection/read/write timeout 分别为 5000/3000/5000ms；无队列、outbox、自动重试或多邮件 provider。SMTP 账号未配置时注册发码/找回返回固定 503 `MAIL_NOT_CONFIGURED`，现有登录与改密仍可用。注册开关关闭时注册发码和最终注册都拒绝，已发注册码也不能绕过开关。

2026-10-29邮件配置补充：用户截图显示IMAP/SMTP服务已开启，SMTP为smtp.126.com、IMAP为imap.126.com，并支持SSL。Manao只需SMTP发送验证码，不实现IMAP收信、邮件轮询或从邮箱自动取码。截图未给端口；依据网易官方帮助选择465/隐式SSL。服务开通状态来自用户截图，不是本轮连接验证结果。

| 配置 | 本次状态 | 后续用途 |
| --- | --- | --- |
| `MANAO_REGISTRATION_ENABLED` | 发布默认 false | 用户授权的人工注册验收窗口启用，正式开放依验收结果决定；本轮不启用 |
| `MANAO_MAIL_ENABLED` | 默认 false；仅在获准配置后启用 | 参数确定不等于已启用 |
| `MANAO_MAIL_HOST` | `smtp.126.com` | SMTP发信服务器 |
| `MANAO_MAIL_PORT` | `465` | 隐式SSL端口，来源为官方帮助 |
| `MANAO_MAIL_USERNAME` | `shilizhengnanren@126.com` | 完整邮箱地址作为SMTP用户名 |
| `MANAO_MAIL_PASSWORD` | 使用用户提供的客户端授权码，运行时Secret注入；文档不保存具体值 | 不是邮箱网页登录密码 |
| `MANAO_MAIL_FROM` | `shilizhengnanren@126.com` | 与SMTP账号一致的发件人 |
| `MANAO_MAIL_TLS_MODE` | `ssl` | 465隐式TLS，不混用STARTTLS，不明文回退 |
| `MANAO_AUTH_CHALLENGE_SECRET` | 发布时安全生成并持久化，至少 32 随机字节 | 验证码 HMAC |

`MANAO_MAIL_*` 在配置类映射至 JavaMailSender 的SMTP属性，启用SMTP认证、隐式SSL和证书/主机名验证，不信任全部证书；保留5000/3000/5000ms超时。不把空授权码当有效配置，不在前端暴露，也不以邮件服务启动为由自动执行SMTP连接测试。客户端授权码已在本会话提供，但本轮不将其存入任何文件；其他agent若没有可用Secret，应在真正需要配置时请用户通过受控渠道注入，不把查找聊天历史当作部署依赖。

官方依据（2026-10-29查询，仅校对配置，未连接SMTP）：网易[客户端配置与SSL端口](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac25c12dcb3d46222b6)、[客户端授权码说明](https://help.mail.126.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac2a5feb28b66796d3b)；Spring Boot 3.5.9 [Sending Email](https://github.com/spring-projects/spring-boot/blob/v3.5.9/spring-boot-project/spring-boot-docs/src/docs/antora/modules/reference/pages/io/email.adoc)此前已通过Context7查询。

人工邮件验收由用户操作注册/找回的发送、收件和验证码提交；agent交付操作清单及无秘密的结果记录模板，涵盖正常送达、过期、重发旧码失效、重复使用和找回闭环。自动化只使用捕获型sender或本地测试替身，不使用真实126账号。用户尚未验证时记 `NOT_RUN（等待用户手动验证）`；用户反馈通过时明确标为用户手动验证，并记录日期/场景，不伪装成agent实测或因mock通过而授予完整PASS。

## 8. 密码更新与旧访问撤销

新 JWT 带整数 `ver`，每次 HTTP 认证检查 app_user 存在、enabled、ver 等于 auth_version；认证主体保持 `getName() == userId`，附带 version 供后续使用。查询失败拒绝访问，不退回只验 JWT。小规模不做身份缓存。部署后旧格式 JWT 一律重新登录一次，保留原账户和密码；不做双格式长期兼容，不改变配置中的 JWT 生命周期。

改/重置密码在一个事务中完成密码哈希更新、auth_version + 1、适用的 challenge 消费、旧 RESERVED ticket 失效。改密还校验请求携带的版本与当前密码，拒绝已过时的请求；提交成功后不再签新 token，要求重新登录。已经由后端接收并执行的普通业务请求不做回滚，不把撤销描述成对过去操作的取消。

### 8.1 未用票据

签发 log/terminal ticket 必须绑定**请求原有版本**，以条件 INSERT/UPDATE 再验用户版本；不能给通过旧 JWT 的请求盖上数据库中的新版本。消费时原子校验 hash、未消费、expiry、enabled 和 ticket.version=user.version。

### 8.2 已有连接

保持目前单 backend 部署，新增一个小型 `UserSessionRevoker`，只登记 userId/version/closeCallback：

```java
Registration register(String userId, long authVersion, Runnable closeCallback);
void closeOlder(String userId, long newVersion);
// Registration.close() 注销；撤销关闭回调幂等，锁外逐一执行。
```

注册与撤销共用短锁和用户版本水位；握手先查当前数据库版本，登记，再查一次新快照，然后才允许发送/打开 PTY。资源打开可能晚于撤销，handler 必须有原子 closed 状态，迟到的 handle/listener 立即关闭，不能重新 ready。只在密码事务提交后 closeOlder，关闭 `< newVersion` 而非所有用户连接。

- 日志：关闭单个 socket，移除 listener；保留采集器与持久日志。
- 终端：复用单会话 settleAndClose，关闭 PTY/exec，结算 session；不停止 Run。
- SSE：detach 旧用户版本对应 subscription，完成 emitter；不调用全局 AgentLiveOutput.close，也不操作 task。
- 旧 WS 使用固定 4401，SSE 发送固定 `auth.revoked` 事件（传输允许时）。前端按建立连接时的认证 snapshot 判断是否清当前会话；旧连接不能清新登录。SSE 无事件异常结束时可用一次 `/auth/me` 验证，401 走统一清理，网络错误只显示断开，不自发重登/无限重连。

本进程立即禁止继续使用被撤销的连接，底层阻塞 socket 按现有发送期限收尾；不承诺已进入网络缓冲区的数据能撤回。单 backend 重启会关闭全部旧连接；此方案不声称支持多 backend 的即时跨节点撤销。

## 9. HTTP 与前端合同

所有路径前缀 `/api/v1/auth`；匿名白名单逐条列举，不开放整个 `/auth/**`。请求拒绝未知字段，错误沿用 ApiError。所有验证码响应 Cache-Control: no-store。

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| GET `/options` | 无 | `{registrationEnabled, emailAvailable}`，不含 sender 信息 |
| GET `/captcha` | 无 | `{challengeId,imageBase64,expiresAt}`，PNG base64 |
| POST `/email-codes` | `{purpose: REGISTER_EMAIL或RESET_PASSWORD,email,captchaId,captchaAnswer}` | 202 `{challengeId,expiresAt,retryAfterSeconds:60}` |
| POST `/register` | `{username,password,email,emailChallengeId,emailCode}` | 201 `{user:{id,username}}`，不含 token |
| POST `/login` | 既有 `{username,password}` | 既有 LoginResponse，user 增可空 email/verified 展示字段 |
| POST `/password-reset` | `{email,emailChallengeId,emailCode,newPassword}` | 204，随后正常登录 |
| POST `/password-change` | 已认证；`{currentPassword,newPassword}` | 204，撤销旧访问 |
| GET `/me` | 已认证 | 当前用户 id/username/email/emailVerified |

固定错误包含 `VALIDATION_ERROR`422、`CAPTCHA_INVALID`422、`EMAIL_CODE_INVALID`422、`AUTH_RATE_LIMITED`429（Retry-After）、`USERNAME_TAKEN`409、`EMAIL_TAKEN`409、`REGISTRATION_CLOSED`403、`MAIL_NOT_CONFIGURED`503、`MAIL_SEND_FAILED`503（仅注册发码）；验证码过期/次数用尽不返回答案或内部原因。全局邮件未配置在检查目标邮箱之前对所有邮箱同样503；找回具体邮件发送失败保持202。重置完成存在/不存在均不能泄露账户内容，未知码统一错误。

前端只增加 `/register`、`/forgot-password`、`/account/password` 三个页面；注册/找回各自同页两步。共用 `CaptchaField`，修改现有 LoginPage 添加入口并去除演示凭据提示，AccountPanel 提供改密入口。不另加 verify-email/reset-password 路由，不重做工作台 UI。邮箱显示仅面向当前用户，页面不存密码/验证码到 localStorage/sessionStorage。

## 10. 验证与完成边界

1. 隔离：selector 两侧项目标签、两策略叠加、创建顺序、旧策略迁移零遗漏、自身允许和跨项目网络拒绝分别验证。
2. 会话：自然过期/退出/401清理等价、重复清理、旧定时器、迟到创建/核对、同账号重登、A→B、旧401与旧流事件不影响新登录。
3. 账户：全新schema与V16升级；旧账户/owner不变；注册前无用户；邮箱唯一；码用途/邮箱/expiry/错误次数/重发/一次性消费；SMTP失败和重启残留SENDING；找回/改密后旧JWT/ticket/连接无效，Run/AI不停止。
4. 流撤销：签发中改密、consume后登记前改密、登记后handle attach前改密、SSE已选中帧时改密；新版本连接不被误关。
5. 双账号顺序验证：每账号8项目，第9个拒绝；项目/文件读写/Run/日志/终端/AI会话和输出不能跨owner访问；公开应用仍匿名可用。

真实MySQL测试沿用 `JdbcStoreTestSupport` 的disposable schema；禁止reset运行库。集群迁移、项目创建和流量探测在明确发布/验收执行阶段进行；真实SMTP验证码流程由用户手动验证。当前邮件补充仍仅是规划，不操作这些环境。测试代码存在、mock通过、源码审核及用户手动验证分别记录，不互相替代。

后续人工绑定旧账号邮箱使用新计划维护脚本，按精确 userId 比对用户名、邮箱为空和唯一性，在用户确认邮箱控制权后条件更新并记录 verified_at；重复执行不覆盖既有邮箱，不提供公网管理员绑定接口。此类账号不得通过重新注册占用旧 id 或转移项目。

设计置信度：现有模块落点和前两项修复高；邮件实际送达、镜像图形码渲染、云端当前策略/CNI及真实跨账号行为需实施证据，不能在规划中标PASS。

## 11. 实施入口

见[实施计划](../plans/2026-10-29-multi-account-implementation-plan.md)。本设计只保留合同；任务勾选归计划，真实结果归 `poc4/docs/evidence/multi-account/acceptance.md`（实施阶段创建）。
