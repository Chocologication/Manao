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

vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  loader: {
    config() {},
    init: () => Promise.resolve({}),
  },
}));

