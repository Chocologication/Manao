import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, applyTheme, isThemePreference, subscribeToThemeChanges, useThemePreferences } from './themePreferences';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useThemePreferences.getState().setPreference('lab');
  localStorage.removeItem(THEME_STORAGE_KEY);
  applyTheme();
});

describe('appearance preferences', () => {
  it('persists the preference and applies colors without replacing the page', () => {
    const stop = subscribeToThemeChanges();
    const root = document.documentElement;
    useThemePreferences.getState().setPreference('light');
    expect(root.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement).toBe(root);
    stop();
  });

  it('tracks system color changes only in system mode and cleans up listeners', () => {
    let dark = false;
    const listeners = new Set<() => void>();
    const removeEventListener = vi.fn((_type: string, listener: () => void) => listeners.delete(listener));
    vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; }, addEventListener: (_type: string, listener: () => void) => listeners.add(listener), removeEventListener }));
    const stop = subscribeToThemeChanges();
    useThemePreferences.getState().setPreference('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    dark = true;
    listeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe('lab');
    useThemePreferences.getState().setPreference('graphite');
    dark = false;
    listeners.forEach((listener) => listener());
    expect(document.documentElement.dataset.theme).toBe('graphite');
    stop();
    expect(listeners.size).toBe(0);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it('synchronizes another tab and ignores unrelated or invalid storage values', () => {
    const stop = subscribeToThemeChanges();
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'graphite' }));
    expect(useThemePreferences.getState().theme).toBe('graphite');
    for (const event of [{ key: 'unrelated', newValue: 'light' }, { key: THEME_STORAGE_KEY, newValue: 'invalid' }]) window.dispatchEvent(new StorageEvent('storage', event));
    expect(useThemePreferences.getState().theme).toBe('graphite');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: null }));
    expect(useThemePreferences.getState().theme).toBe('lab');
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
    expect(useThemePreferences.getState().theme).toBe('lab');
  });

  it('remains usable when localStorage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    useThemePreferences.getState().setPreference('light');
    expect(useThemePreferences.getState().theme).toBe('light');
  });

  it.each(['invalid', null, {}, 1])('rejects an invalid theme %j', (value) => {
    expect(isThemePreference(value)).toBe(false);
  });
});
