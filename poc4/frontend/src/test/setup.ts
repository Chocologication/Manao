import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from '../mocks/node';
import { resetLogTickets } from '../mocks/runSocket';
import { resetMockState } from '../mocks/state';
import { resetTerminalSockets } from '../mocks/terminalSocket';

if (typeof document.queryCommandSupported !== 'function') {
  document.queryCommandSupported = () => false;
}

if (typeof globalThis.ClipboardItem === 'undefined') {
  globalThis.ClipboardItem = class {
    readonly items: Record<string, Blob | string | Promise<Blob | string>>;
    constructor(items: Record<string, Blob | string | Promise<Blob | string>> = {}) {
      this.items = items;
    }
    static supports() {
      return false;
    }
  } as unknown as typeof ClipboardItem;
}

if (typeof navigator.clipboard?.write !== 'function') {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async () => {},
      writeText: async () => {},
      readText: async () => '',
    },
  });
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: (() => null) as typeof HTMLCanvasElement.prototype.getContext,
});

vi.mock('@monaco-editor/react', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ path }: { path?: string }) =>
      createElement('div', { 'data-testid': 'mock-editor', 'data-path': path ?? '' }),
    loader: {
      config() {},
      init: () => Promise.resolve({}),
    },
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetTerminalSockets();
  resetMockState();
  resetLogTickets();
});
afterAll(() => server.close());
