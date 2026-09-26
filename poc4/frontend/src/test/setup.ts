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

/**
 * jsdom implements ClipboardItem but never consumes the promises passed as item
 * values. Monaco's clipboardService installs a click/keydown workaround on the
 * container (loaded with the workbench editor module graph) that creates a
 * DeferredPromise per event and cancels the previous one, so the second user
 * gesture in a jsdom document rejects that first promise with nobody attached —
 * an unhandled rejection. The stub below consumes every promise item exactly
 * like a real browser settling a clipboard payload. It only affects the already
 * browser-mocked ClipboardItem; all other unhandled rejections stay loud.
 */
if (typeof globalThis.ClipboardItem === 'function') {
  const RealClipboardItem = globalThis.ClipboardItem;
  globalThis.ClipboardItem = class extends RealClipboardItem {
    constructor(items: Record<string, Blob | string | Promise<Blob | string>> = {}) {
      for (const value of Object.values(items)) {
        void Promise.resolve(value).catch(() => {});
      }
      super(items);
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
    // Mirrors the props the real Editor binding receives; the readOnly option is
    // exposed so tests can assert the editor's actual read-only state.
    default: ({ path, options }: { path?: string; options?: { readOnly?: boolean } }) =>
      createElement('div', {
        'data-testid': 'mock-editor',
        'data-path': path ?? '',
        'data-readonly': options?.readOnly === true ? 'true' : 'false',
      }),
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
