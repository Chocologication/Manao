import { builtinEnvironments } from 'vitest/environments';

export default {
  name: 'jsdom-node-abort',
  transformMode: 'web' as const,
  async setup(global: typeof globalThis, options: Record<string, unknown>) {
    const NodeAbortController = global.AbortController;
    const NodeAbortSignal = global.AbortSignal;
    const env = await builtinEnvironments.jsdom.setup(global, options);
    Object.defineProperty(global, 'AbortController', {
      configurable: true,
      writable: true,
      value: NodeAbortController,
    });
    Object.defineProperty(global, 'AbortSignal', {
      configurable: true,
      writable: true,
      value: NodeAbortSignal,
    });
    return env;
  },
};
