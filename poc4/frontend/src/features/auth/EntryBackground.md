# 入场页：立体云端实验室

## 设计与范围

桌面认证入口采用立体云端实验室：远处计算节点阵列、中景悬浮开发模块、透视数据光路与近处代码流。极光降为淡淡的蓝白环境光，前景用分层工作平台和脉冲光路连接代码、创意核心、AI 协作及云端环境；右侧保留深蓝外壳与白色表单。左侧显示 Manao / 云端开发实验室。无声音、外部图片、视频、字体下载或新增依赖。

四份代码预览分别使用 Python、Java、JavaScript、TypeScript，标注「视觉示意」。背景不读取项目、调用模型或伪造服务状态。

## 动画与交互

首次进入认证区域的 GSAP timeline 为 4.5 秒：

| 时间 | 内容 |
| --- | --- |
| 0–1.2 s | 云端节点、数据光路与环境光展开 |
| 0–4.5 s | 镜头穿过计算空间、分层代码流和光点，逐渐减速至停止 |
| 0.4–3.1 s | 代码面板、核心与分层平台从远处进入 |
| 2.1–3.1 s | 品牌与中文主题出现 |
| 2.7–3.9 s | 场景移至左侧 |
| 3.4–4.5 s | 右侧控制台展开，表单可操作 |

开场期间「跳过动画」始终可用，表单使用 inert 避免焦点进入不可见区域。跳过后将键盘焦点移至首个输入框。镜头进度由 GSAP 与背景共享，不通过每帧 React state 更新。完整播放或跳过后，只停止镜头推进；模块浮动、光路脉冲、环境光、粒子与代码流保持原有环境动画速度和数量，不因表单出现而弱化。代码示例每 5 秒交替，全部四种语言为一个 20 秒周期。

鼠标产生柔和局部光晕，照亮 300px 内的节点及连线，并轻微改变左侧场景的倾角与位置。使用 quickTo 复用 tween；登录表单不参与鼠标位移。三层背景代码使用不同尺寸、透明度和速度；标题和表单附近降低背景细节对比度，保持可读性。布局和元素尺寸沿用凌晨版本。

计算节点、悬浮模块和地面数据光路共用透视投影。节点使用前 / 顶 / 侧面表现体积，按深度绘制；底层不透明表面遮挡远处节点。背景模块附近鼠标高亮半径为 280px。前景模块仅上下浮动 5px，光路沿 SVG path 流动，均复用 GSAP 的生命周期与暂停逻辑。

系统 reduced-motion 或应用关闭动态效果时，直接显示完整布局，背景静止、不跟随鼠标。运行中开启 reduced-motion 会结束开场；重新允许动画只恢复环境动效，不重播开场。

## 路由与认证兼容

- AppRouter 的 EntryRouteLayout 持久挂载于 /login、/register、/forgot-password 的共同父路由；切换表单、登录失败及重试不会重播开场。
- 离开认证区域时释放场景；重新进入或刷新页面重播。没有使用 localStorage 或 sessionStorage 保存播放状态。
- EntryLayout 在共同布局内只输出表单；独立账号页（如修改密码）仍能复用同一视觉。
- 登录成功过渡使用 portal，避免受控制台的 perspective 包含块影响。
- 认证 API、字段、token 生命周期、密码校验、后端配置和数据库均不变。

## 实现与降级

| 文件 | 职责 |
| --- | --- |
| EntryLayout.tsx | 共享认证路由、4.5 秒 timeline、跳过与焦点 |
| EntryLab.tsx | 四语言代码示例、SVG 核心、模块浮动、光路与鼠标倾斜 |
| EntryAtmosphere.tsx | 两层 Canvas 挂载与 CSS fallback |
| entryFlowField.ts | 统一绘制时钟、镜头投影、粒子、代码流、节点、降级极光 |
| entryComputeSpace.ts | 无独立时钟的计算节点、空间框架、悬浮模块与数据光路绘制 |
| entryAurora.ts | 可选 WebGL 环境光、淡极光与 GPU 资源管理 |
| LoginPage.module.css | 认证页独立配色、控制台与桌面布局 |

Canvas2D 高档最多 260 粒子、15 条背景代码、1.65M 像素和 60 fps 目标；低性能 / 省流设备为 85 粒子、9 条代码、0.9M 像素和 30 fps 目标。WebGL 极光单独限制为高档约 0.48M / 低档约 0.23M 像素，两者共用一个 rAF。连续慢帧自动降档；目标频率不是所有硬件的实测保证。每帧无网络请求、无 React state 更新。

计算空间高档为 24 个阵列节点及 4 个悬浮模块，低档为 12 个阵列节点及 4 个悬浮模块；不增加 Canvas、rAF、事件监听器或第三方依赖。

document 隐藏时暂停 timeline、代码切换、核心光晕、模块浮动、SVG 光路和两层 Canvas；Canvas 离开可视区域时暂停绘制。WebGL 不可用或 context loss 时保留完整 Canvas2D 计算空间与简化环境光；Canvas2D 不可用时使用 CSS 静态背景。恢复 context 后重新准备资源并绘制，包括 reduced-motion 下的静态画面。卸载清理 observer、事件、tween、rAF、GPU buffer / shader / program 与两层 backing store；仅在 Canvas 脱离 DOM 后释放 WebGL context，避免影响 StrictMode 和动态偏好切换。

桌面布局覆盖 1280×720 至超宽屏；短窗口压缩登录间距，注册长表单允许滚动。窄窗口仅提供基础可达布局，未进行手机视觉设计。

## 运行与验证

在 poc4/frontend 目录运行：

```powershell
pnpm dev:mock --host 127.0.0.1 --port 4183 --strictPort
pnpm exec playwright test --config playwright.login-entry.config.ts
```

独立 E2E config 使用 4184，自动启动并回收 mock 服务；默认 Chromium。本机 Edge 可设置 MANAO_ENTRY_BROWSER=msedge。账号 alice / demo-pass 仅为 mock 数据，真实邮箱和后端需单独验证。

测试覆盖完整播放、跳过、重试、认证路由切换、代码预览轮换、鼠标与稳定表单、注册/找回密码 mock 闭环、桌面尺寸、reduced-motion、隐藏暂停、低性能模拟、Canvas fallback、context loss/restore、卸载及主题隔离。

验证结果以 PR 检查和本地 E2E 日志为准；本文件只记录实现约定，不依赖仓库外的验收记录文件。
