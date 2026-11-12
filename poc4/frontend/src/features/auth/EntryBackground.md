# 入场页：Execution Atlas / 执行印刷场

## 项目与设计

实际入口为 `/login`，React 19 + TypeScript + Vite；入口组件 `LoginPage.tsx`，GSAP 与 `@gsap/react` 已存在。项目 README、登录文案和 Run/Terminal 合同表明，码瑙围绕云端文件编辑、Java/Python 运行、日志与历史证据、AI 诊断工作，面向需要复现实验的开发者和学习者。

因此背景表达的是“源码经过执行，留下可核对的证据”，而不是泛用的 AI 宇宙。暖纸色底、深墨结构、钴蓝执行层、橙色扫描标记共同构成斜向贯穿全屏的执行印刷场。源码与证据纸页是前景，展开的执行层为中景，浅色工作底版为背景。阅读区不使用白色遮罩洗淡画面。

画面中的 Python 示例为 `values = [3, 1, 4, 1, 5]; total = sum(values); print(total)`，输出对应 `14`。明确标注“工作流动态示意 / EXAMPLE”，不是后台实时数据，不捏造运行时长、地域或线上状态。

## 实际运行的参考与三种方向

2026-10-31 使用 Chromium 打开在线页面、等待运行并保存前后帧；截图与 HTTP 结果见 `E:/测试/manao-entry-atlas/`。Stars/Forks 是当天 GitHub API 快照，不能视为永久数字。

| 方向 / 项目 | 实际 Demo | Stars / Forks | 技术与 License | 观察、取舍与性能成本 |
| --- | --- | --- | --- | --- |
| 空间数据地形 / [Three.js](https://github.com/mrdoob/three.js) | [Dynamic instancing](https://threejs.org/examples/webgl_instancing_dynamic.html)，HTTP 200，实际看到连续起伏的青紫色方块地形 | 117273 / 36835 | WebGL / InstancedMesh，[MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) | 空间规模感强，适合数据地形；大量实例、持续矩阵更新和 WebGL 初始化有成本，且不能直接表达源码与证据关系，未引入。 |
| 连续材质流动 / [WebGL Fluid Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) | [在线流体](https://paveldogreat.github.io/WebGL-Fluid-Simulation/)，HTTP 200，运行并移动鼠标观察彩色涡流 | 16781 / 1920 | 多 pass WebGL 流体，[MIT](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation/blob/master/LICENSE) | 动态丰富，但显著偏向流体实验、鼠标反馈与高光；计算依赖纹理、分辨率和 GPU，与本次业务叙事不符，未复用。 |
| 编辑式排版与分阶段流程 / [GSAP](https://github.com/greensock/GSAP) | [实际官网](https://gsap.com/)，HTTP 200，观察 `Animate Anything` 字形、图形错位组织和滚动衔接 | 29964 / 2319 | DOM/SVG/JS timeline；[GSAP Standard License](https://gsap.com/standard-license/)，不是 MIT | 选择其“内容与运动统一编排”的原则；保留既有 GSAP，背景原创 Canvas2D 执行印刷场，避免新增 3D 引擎和素材。 |
| 额外排除 / [Anime.js](https://github.com/juliangarnier/anime) | [实际官网](https://animejs.com/)，HTTP 200，观察首屏与后续动效 | 74101 / 5023 | JS/SVG/WebGL 编排，[MIT](https://github.com/juliangarnier/anime/blob/master/LICENSE.md) | 序列设计可借鉴；实际首屏的环形视觉违反本任务限制，不采用，也不新增重复动画库。 |

三个主要方向分别是空间地形、连续流体、编辑式执行叙事；它们的构图和运动机制不同，不是更换粒子密度或中心物体。

另检查了 [Codrops OnScrollTypographyAnimations](https://github.com/codrops/OnScrollTypographyAnimations) 源码介绍与 MIT License。其 [Demo](https://tympanus.net/Development/OnScrollTypographyAnimations/) 在当前环境返回 HTTP 403 检查页，未把它写成已观看的演示。Pudding 参考页超时，同样未采用。

参考网站的视觉不等于可以复制网站素材。上述视频、截图、字体、网页源码均未进入产品。Canvas 几何、纸页面板、扫描和颜色由本项目重新实现。实际继续使用的 GSAP Standard License 允许此类网站/应用使用，限制竞争性可视化动画编辑工具；保留依赖自带版权声明。

## 实现、作用域与资源

- `entryFlowField.ts`：原创 Canvas2D 场景。只有一个渲染循环，不使用 WebGL、视频、粒子或鼠标监听。
- `EntryAtmosphere.tsx`：页面级挂载、静态 fallback 和场景标注；移除光标、光晕、网格覆盖层等旧 DOM。
- `LoginPage.module.css`：清理旧背景和鼠标效果；暖纸底、通栏导航、稳定阅读区、实色表单；只使用页面作用域变量与选择器。
- `LoginPage.tsx`：仅调整入场 tween，表单从可见明度开始，不在认证回退时被 opacity:0 隐藏；未修改认证、路由或请求逻辑。保留已有 scoped useGSAP 时间轴和 cleanup。
- `tests/e2e/login-entry.spec.ts`：桌面尺寸、登录、focus、reduced-motion、隐藏暂停、低性能、context/fallback、卸载释放与主题隔离验证。
- `EntryBackground.md`：本说明。

本轮新增视频/图片/字体资源 **0 bytes**，新增依赖 **0**。截图与录屏只在外部验收目录，不进入首屏下载。

动画的单一周期为 18 秒：0–3 s 源码显影；3–7 s 执行层展开；7–11 s 扫描逐层推进；11–15 s 结果与证据打印；15–18 s 回收复位。所有过渡在周期两端归零，避免不相干 sine 频率造成假循环。首次页面无需等待完整周期即可操作。

普通设备 Canvas 上限约 1.65M 像素；低性能/省流设备约 0.9M、7 层和 30 fps 目标，高档最多 10 层、60 fps 目标。目标频率不是实测保证。持续绘制成本偏高时自动降档。页面隐藏、离开可视区域、context loss 时停止 rAF；卸载释放监听器、observer、帧和 Canvas backing store。

reduced-motion 显示经过设计的 12 s 证据阶段静帧；Canvas 不可用时切换纯 CSS 纸页与执行层静态构图。保留系统光标和原有键盘操作。只针对桌面构图，没有移动端改造。

## 启动

```powershell
cd C:\Users\Y\AppData\Local\Temp\Manao-preview\poc4\frontend
pnpm dev:mock --host 127.0.0.1 --port 4175
```

预览：<http://127.0.0.1:4175/login>。`alice / demo-pass` 为 README 中已有的 mock 凭据，不是真实生产账号。

## 验收记录

2026-11-01 在 Chromium 桌面环境复测：`pnpm exec eslint src/features/auth/entryFlowField.ts src/features/auth/EntryAtmosphere.tsx src/features/auth/LoginPage.tsx tests/e2e/login-entry.spec.ts` 与 `pnpm typecheck` 通过；生产构建通过（84 秒）。项目边界检查 36/36 通过，Browser boundary check 通过。认证/路由回归 32/32 通过，登录单测 16/16 通过。

Playwright 入场 E2E 9/9 通过，覆盖 1280×720、1280×800、1920×1080、2560×1440、3440×1440，无横向溢出；检查登录失败/成功、密码显示、按钮 hover、键盘 focus、reduced-motion 切换与初始设置、页面隐藏暂停、低性能模拟、Canvas 不可用 fallback、context loss/restore、离开登录页后 backing store 释放和样式隔离。低性能用例首次与构建/全量测试并行时超过点击等待上限；停止竞争负载后单项与完整 E2E 均复测通过。

另以 Chromium 录制完整 37 秒，覆盖两个 18 秒循环：共采样 2212 帧，rAF 间隔中位数与 P95 均为 16.7 ms；循环边界抽样红通道均值差为 0，阶段顺序在两轮一致。它是该次 Chromium 录制的间隔/接缝测量，不代表不同设备上的稳定 FPS 或 GPU 性能保证。浏览器 Console 错误与资源加载失败均为 0。录屏 4,156,190 bytes（约 3.96 MiB），未进入项目资源；截图和探针报告位于外部验收目录。

完整 `pnpm test --maxWorkers=2` 收集到并运行的 1632 项测试全部通过，但命令因现存 `tests/visual/ai-ui.spec.ts` 被 Vitest 收集后调用 Playwright `test()` 而以失败结束。完整 lint 仍报告仓库其他目录的 35 个错误、9 个警告；本次触及的页面文件定向 ESLint 通过。生产构建有既有大 chunk 提示（WorkbenchPage 约 4.03 MB，未在本次范围内拆包）。真实后端、实体 GPU 占用和长期内存稳定性未验证；登录验证使用项目现有 mock 服务。
