import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { runLogsSocketHandler } from './runSocket';

export const worker = setupWorker(...handlers, runLogsSocketHandler);

export async function startMockWorker(): Promise<void> {
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: {
      url: '/mockServiceWorker.js',
    },
  });
}
