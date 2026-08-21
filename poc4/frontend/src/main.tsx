import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/AppProviders';
import { AppRouter } from './app/AppRouter';
import { AppErrorBoundary } from './components/feedback/AppErrorBoundary';
import './styles/globals.css';

async function bootstrap(): Promise<void> {
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
