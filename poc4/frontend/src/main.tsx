// Monaco 在模块初始化时注册菜单文案，语言包必须先于编辑器模块加载。
import 'monaco-editor/esm/nls.messages.zh-cn.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/AppProviders';
import { AppRouter } from './app/AppRouter';
import { AppErrorBoundary } from './components/feedback/AppErrorBoundary';
import './styles/globals.css';
import { applyTheme } from './features/preferences/themePreferences';

async function bootstrap(): Promise<void> {
  applyTheme();
  if (import.meta.env.VITE_ENABLE_MOCK_API === 'true') {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <AppProviders>
          <AppRouter />
        </AppProviders>
      </AppErrorBoundary>
    </StrictMode>,
  );
}

void bootstrap();
