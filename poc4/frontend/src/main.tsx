import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/AppProviders';
import { AppRouter } from './app/AppRouter';
import './styles/globals.css';

async function bootstrap(): Promise<void> {
  if (import.meta.env.VITE_ENABLE_MOCK_API === 'true') {
    const { startMockWorker } = await import('./mocks/browser');
    await startMockWorker();
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppProviders>
        <AppRouter />
      </AppProviders>
    </StrictMode>,
  );
}

void bootstrap();
