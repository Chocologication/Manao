import { describe, expect, it, vi } from 'vitest';
import { createUuid } from './uuid';

describe('createUuid', () => {
  it('uses native UUID generation when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-4234-8234-123456789abc' });
    try {
      expect(createUuid()).toBe('12345678-1234-4234-8234-123456789abc');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [0x00, '00000000-0000-4000-8000-000000000000'],
    [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('sets v4 and variant bits without randomUUID for random byte %i', (byte, expected) => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(byte));
    vi.stubGlobal('crypto', { getRandomValues });

    try {
      expect(createUuid()).toBe(expected);
      expect(getRandomValues).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
