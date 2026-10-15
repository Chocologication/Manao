import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocalPreferences } from './useLocalPreferences';

const defaults = { view: 'grid', sort: 'newest' };
const parse = (value: unknown) => ({ ...defaults, ...(value && typeof value === 'object' ? value : {}) });
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('local preferences', () => {
  it('merges consecutive changes and synchronizes another mounted consumer', () => {
    const first = renderHook(() => useLocalPreferences('test:alice', defaults, parse));
    const second = renderHook(() => useLocalPreferences('test:alice', defaults, parse));
    act(() => {
      first.result.current.update({ view: 'list' });
      first.result.current.update({ sort: 'name' });
    });
    expect(first.result.current.value).toEqual({ view: 'list', sort: 'name' });
    expect(second.result.current.value).toEqual(first.result.current.value);
  });

  it('isolates account switches and restores the previous account', () => {
    const hook = renderHook(({ account }) => useLocalPreferences(account, defaults, parse), { initialProps: { account: 'alice' } });
    act(() => hook.result.current.update({ view: 'list' }));
    hook.rerender({ account: 'bob' });
    expect(hook.result.current.value).toEqual(defaults);
    act(() => hook.result.current.update({ sort: 'oldest' }));
    hook.rerender({ account: 'alice' });
    expect(hook.result.current.value).toEqual({ view: 'list', sort: 'newest' });
  });

  it('preserves consecutive changes without storage and resets defaults', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const hook = renderHook(() => useLocalPreferences('test:blocked', defaults, parse));
    act(() => { hook.result.current.update({ view: 'list' }); hook.result.current.update({ sort: 'name' }); });
    expect(hook.result.current.value).toEqual({ view: 'list', sort: 'name' });
    act(() => hook.result.current.reset());
    expect(hook.result.current.value).toEqual(defaults);
  });
});
