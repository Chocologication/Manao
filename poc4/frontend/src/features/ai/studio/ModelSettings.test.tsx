import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpClient, setHttpClient } from '@/api/httpClient';
import { ModelSettings } from './ModelSettings';
import type { ModelInput } from './types';

const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal'),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close'),
};

afterEach(() => {
  cleanup();
  setHttpClient(null);
  vi.unstubAllGlobals();
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

it('opens and saves the first model without randomUUID on an HTTP origin', async () => {
  // jsdom does not implement modal dialogs; keep the browser-visible open state.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
  const original = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
  const requests: ModelInput[] = [];
  setHttpClient(new HttpClient({ getAccessToken: () => null, onUnauthorized: vi.fn(),
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as ModelInput;
      requests.push(input);
      return Response.json({ ...input, apiKey: undefined, keyConfigured: true });
    },
  }));
  const user = userEvent.setup();
  render(<ModelSettings models={[]} onClose={() => {}} onSaved={() => {}} />);

  expect(screen.getByRole('dialog', { name: '模型设置' })).toBeVisible();
  await user.type(screen.getByLabelText('显示名称'), 'HTTP model');
  await user.type(screen.getByLabelText('API 密钥'), 'test-only-key');
  await user.click(screen.getByRole('button', { name: '保存配置' }));

  expect(requests).toHaveLength(1);
  expect(requests[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
