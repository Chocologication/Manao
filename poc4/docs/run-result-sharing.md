# 运行结果分享

在“运行记录”中选择一次已结束的运行，点击“分享运行结果”，核对预览后填写标题与可选说明，再生成链接。可以复制链接或展示同一链接的二维码；接收者打开链接即可查看，无需登录。

分享保存服务端数据库当时保留的全部日志、运行状态、退出码、运行时间和语言环境。它不会补采已经清理的日志，也不承诺完整采集。空日志可以分享，显示“暂无可分享的日志”。标题、说明和日志均以普通文本展示。

允许分享 `SUCCEEDED`、`FAILED`、`CANCELLED`、`TIMED_OUT`；同项目另一条运行仍在执行，不影响所选历史终态的资格。每次运行最多有一个有效链接，再次打开弹窗会进入已有链接的管理界面。生成结果暂时无法确认时，使用“找回原结果”恢复同一次请求，勿重复新建。

每个链接自生成起固定 72 小时有效，访问不会续期。源日志清理、删除源项目或后端服务重建均不改变已生成的独立快照。项目删除后，仍可从账户面板的“我的分享”找到并撤销。撤销或到期后，匿名刷新会显示失效；接收者已经看到或另存的内容无法收回。

到期立即拒绝服务端读取，后台每 2 小时回收一次到期正文；撤销同步清空正文。管理摘要与请求收据保留，旧请求重试不能让失效链接复活。撤销或到期后，若源项目和运行还存在且可读，可以生成新的 72 小时链接。

2026-11-16 已完成本地真实服务闭环：生成、匿名读取、源项目删除后原文保持、账户撤销及匿名失效。容量、权限、历史失败和测试环境差异见[验收记录](evidence/run-result-sharing/acceptance.md)及[安全收据](evidence/run-result-sharing/verification-2026-11-16.json)。本功能的云端发布尚未执行。

## 运行专用验收

由 operator 预先准备当前源码的真实站点、专属账号、隔离数据库和可用的 Kubernetes 运行环境。在同一私密进程中注入 `MANAO_BASE_URL`、`MANAO_RUN_SHARE_USERNAME`、`MANAO_RUN_SHARE_PASSWORD`；站点必须是无 userinfo/query/fragment 的 HTTP(S) origin。配置缺失直接失败，不会自动启动服务或回退到 mock。需要独立集群残留核对时，显式提供 `KUBECONFIG` 和 `MANAO_K8S_NAMESPACE`。

```powershell
pnpm --dir poc4/frontend exec playwright test --config playwright.run-sharing.config.ts
```

此配置只执行本功能的一条真实服务测试，单 Chromium、单 worker、零自动重试。测试创建一个 Java 控制台项目并运行一次，由 UI 生成分享、匿名读取、精确删除源项目并确认 404、匿名刷新逐字比较、从“我的分享”撤销，再确认匿名 410。不会执行 AI、安装应用依赖、分配应用公网端口或更改既有 Stage 6 gate。

本地 `poc4/frontend/test-results/run-sharing/` 下的 invocation 账本仅记录 owner/project/run/share ID、项目 creationKey、分享 requestId、到期时间、日志摘要和清理状态。不保存密码、access token、分享 token、完整分享 URL、trace、截图或视频。清理只消费本次账本里的精确资源；项目 API 404、集群残留和数据库关联行的核对分别记录，不能互相替代。

测试会在失败后、源数据清理前保存实际 Run 的状态/退出码/终止原因、安全断言标量及默认测试运行日志诊断；原始运行诊断仅位于 ignored 测试目录，交付收据只保留摘要/字节数。登录状态仅存内存，runner通过重新登录与SPA链接导航；匿名接收页保持独立context，允许直接打开与刷新。

## 发布与回滚顺序

先执行加法迁移 `V22__run_shares.sql`，确认旧业务数据与历史 checksum 保持一致，再发布后端，最后发布前端。真实入口必须让 `/shares/:token` 直接打开及刷新时返回 SPA，并把 `/api/v1/public/run-shares/*` 交给后端；二维码与页面链接使用相同 origin。

业务回滚恢复上一版前后端，保留新表及既有分享数据，不删除表回滚。新版本后端再次启用后恢复生命周期维护。发布、运行库迁移和云端验证需独立授权与记录，本地验收不代表已发布。

设计与任务边界见[设计](../../docs/superpowers/specs/2026-11-16-run-result-sharing-design.md)和[实施计划](../../docs/superpowers/plans/2026-11-16-run-result-sharing.md)。
