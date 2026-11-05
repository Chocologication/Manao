# 外观偏好

入口：登录后右上角「账户与偏好 → 外观」。

- `AppearanceSettings.tsx` / `AppearanceSettings.module.css`：日间浅色、深蓝实验室、石墨深色和跟随系统；工作台缩略图、选择状态及动态效果开关。跟随系统的缩略图通过 `prefers-color-scheme` 预览系统配色，不受手动选中的主题影响。
- `themePreferences.ts`：沿用 `manao.appearance.v1` 与 `light/lab/graphite/system` 存储值，保留已有选择；默认值和「恢复全部偏好」统一使用 `DEFAULT_THEME_PREFERENCE = light`。
- 页面、Monaco 和 xterm 沿用现有订阅同步。刷新保存、跨标签页同步与系统明暗监听继续由原偏好模块管理。
- 原生 radio 支持方向键选择和可见 focus；动效开关保留原生 checkbox。系统减少动态效果设置优先。较矮桌面窗口使用更紧凑的预览和间距。

相关验证：

```powershell
pnpm exec vitest run src/features/preferences/themePreferences.test.ts src/components/shell/AccountPanel.test.tsx src/features/terminal/XtermTerminalAdapter.test.ts --maxWorkers=2
pnpm exec eslint src/components/shell/AccountPanel.tsx src/components/shell/AccountPanel.test.tsx src/features/preferences/AppearanceSettings.tsx src/features/preferences/themePreferences.ts
pnpm build
pnpm test:boundary
```

本地 mock 的 AI `agent-tasks/current` 接口仍可能返回 404；外观验证不代表真实 AI 或云端终端验收。
