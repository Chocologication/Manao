import { describe, expect, it, vi } from 'vitest';
import { guardedLookup, publicModelAddress, createModelTransport } from '../src/model-transport.js';
import type { lookup } from 'node:dns';

describe('personal model transport', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])('refuses %s', address => {
    expect(publicModelAddress(address)).toBe(false);
  });
  it('uses checked DNS results at the socket and rejects mixed public/private results', () => {
    const callback = vi.fn();
    const resolver = vi.fn((_host, _options, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
    guardedLookup(resolver as unknown as typeof lookup)('provider.invalid', {}, callback);
    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    const publicResolver = ((_host, _options, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }])) as typeof lookup;
    callback.mockClear(); guardedLookup(publicResolver)('provider.invalid', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it('blocks private literals and cross-origin requests without contacting a model', async () => {
    const transport = createModelTransport('https://127.0.0.1/v1');
    try {
      await expect(transport.fetch('https://127.0.0.1/v1/chat/completions')).rejects.toThrow('endpoint');
      await expect(transport.fetch('https://example.org/v1')).rejects.toThrow('endpoint');
    } finally { transport.close(); }
  });
});
