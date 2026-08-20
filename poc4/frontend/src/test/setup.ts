import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

if (typeof document.queryCommandSupported !== 'function') {
  document.queryCommandSupported = () => false;
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

