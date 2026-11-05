# 账号入口

`/login`、`/register`、`/forgot-password` 和 `/account/password` 共用新的入口视觉。`EntryLayout.tsx` 管理背景和入场动画；`AuthPageFrame.tsx` 为注册、找回密码和修改密码提供统一表单。入口页配色独立于工作台主题，支持 reduced-motion，账号表单支持窄屏。

## 页面流程

- 注册：填写用户名、邮箱、密码、确认密码和图形验证码；发送邮件后填写 6 位邮箱验证码，注册成功返回登录页，不自动登录。
- 用户名冲突时可直接修改用户名并复用有效邮箱验证码；修改邮箱会清空原 challenge 并刷新图形验证码。重发遵守服务端冷却时间。
- 找回密码：邮箱和图形验证码 → 邮箱验证码及新密码 → 返回登录。发送结果使用统一提示，不暴露邮箱是否存在。
- 修改密码：当前密码和新密码 → 成功后撤销旧会话并返回登录。迟到的旧请求不能退出新的登录会话，成功提示只消费一次。

用户名和邮箱在提交前 trim/lowercase，具体合法性由后端验证。新密码使用 `registrationValidation.ts`，校验 8–64 个 Unicode code points 和 BCrypt 的 72 UTF-8 bytes 限制。密码和邮箱验证码保留在组件内存，不写入 URL、Web Storage 或日志。页面卸载后忽略请求结果。

注册配置加载成功前禁止发送验证码；配置加载失败、注册关闭、邮件不可用、限流、网络失败和验证码无效均有页面反馈。

## API 与源码整合

沿用上游 multi-account API 的路径与请求/响应字段：

- `GET /api/v1/auth/options`
- `GET /api/v1/auth/captcha`
- `POST /api/v1/auth/email-codes`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/password-reset`
- `POST /api/v1/auth/password-change`

本次本地整合以 GitHub `e99b88e5d9f6856527c81639ee23719b748a3bbb` 官方源码快照为基础，保留本地登录视觉、注册入口和工作台主题。后端账号源码、迁移及部署说明同步到项目，但未启动或部署真实服务。Git fetch 失败后使用官方 compare diff 和 archive 获取源码，当前 checkout 的 HEAD 不代表已 fast-forward 到上述提交。未提交或推送 GitHub。

## 本地 mock

`--mode mock` 使用上游账号生命周期 test double：接受任意非空图形验证码答案和任意 6 位数字邮箱验证码，不发送真实邮件。验证码图片仅作演示，不要求固定答案。mock 模拟 challenge 消费、邮箱绑定、有效期、重发冷却和改密后 token 失效，不模拟真实验证码猜测防护。

新 mock 用户保存在当前页面运行期内存，整页刷新会重置。生产构建排除 mock handlers、演示图片及 mock 提示。

## 验证范围

整合验证包含前端 TypeScript、相关 ESLint、Vitest、Playwright 账号生命周期及登录动画、生产构建和 browser boundary。精确结果见[本次本地整合记录](../../../../docs/evidence/frontend-integration/2026-11-02.md)。

本地浏览器测试使用 mock，不代表真实后端、真实邮箱投递或真实 AI 模型已经联调通过。
