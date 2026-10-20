import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { runLogsSocketHandler } from './runSocket';
import { terminalSocketHandler } from './terminalSocket';

export const worker = setupWorker(...handlers, runLogsSocketHandler, terminalSocketHandler);

export async function startMockWorker(): Promise<void> {
  if (import.meta.env.VITE_AI_UI_FIXTURE === 'true') {
    const { aiUiHandlers } = await import('./aiUiFixture');
    worker.use(...aiUiHandlers);
  }
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: {
      url: '/mockServiceWorker.js',
    },
  });
}
