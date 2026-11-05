import { create } from 'zustand';
import type { ITheme } from '@xterm/xterm';

export type Theme = 'lab' | 'graphite' | 'light';
export type ThemePreference = Theme | 'system';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';
export const THEME_STORAGE_KEY = 'manao.appearance.v1';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'lab' || value === 'graphite' || value === 'light' || value === 'system';
}

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch { return DEFAULT_THEME_PREFERENCE; }
}

function resolveTheme(preference: ThemePreference): Theme {
  if (preference !== 'system') return preference;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'lab' : 'light';
}

const initialPreference = readPreference();
export const useThemePreferences = create<{
  preference: ThemePreference;
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
}>((set) => ({
  preference: initialPreference,
  theme: resolveTheme(initialPreference),
  setPreference: (preference) => {
    if (!isThemePreference(preference)) return;
    try { localStorage.setItem(THEME_STORAGE_KEY, preference); } catch { /* Keep the current-tab preference when storage is unavailable. */ }
    set({ preference, theme: resolveTheme(preference) });
  },
}));

export function applyTheme(): void {
  document.documentElement.dataset.theme = useThemePreferences.getState().theme;
}

export function subscribeToThemeChanges(): () => void {
  applyTheme();
  const unsubscribe = useThemePreferences.subscribe(applyTheme);
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const updateSystem = () => {
    const { preference } = useThemePreferences.getState();
    useThemePreferences.setState({ theme: resolveTheme(preference) });
  };
  const updateFromStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const preference = event.key === null || event.newValue === null ? DEFAULT_THEME_PREFERENCE : event.newValue;
    if (isThemePreference(preference)) useThemePreferences.setState({ preference, theme: resolveTheme(preference) });
  };
  media?.addEventListener('change', updateSystem);
  window.addEventListener('storage', updateFromStorage);
  updateSystem();
  return () => {
    unsubscribe();
    media?.removeEventListener('change', updateSystem);
    window.removeEventListener('storage', updateFromStorage);
  };
}

export const terminalThemes: Record<Theme, ITheme> = {
  lab: { background: '#0c1220', foreground: '#e8efff', cursor: '#78a6ff', selectionBackground: '#30466d', black: '#151f32', red: '#ff7d86', green: '#70d6a1', yellow: '#f1bd68', blue: '#78a6ff', magenta: '#d5a7ef', cyan: '#71d6d4', white: '#e8efff', brightBlack: '#8294b0', brightRed: '#ff9ba2', brightGreen: '#9ce9ba', brightYellow: '#ffd88f', brightBlue: '#a8c8ff', brightMagenta: '#e9c2ff', brightCyan: '#9ef3f0', brightWhite: '#f4f8ff' },
  graphite: { background: '#111315', foreground: '#edf0f2', cursor: '#a9d6ff', selectionBackground: '#304354', black: '#202428', red: '#ff8d95', green: '#7edbae', yellow: '#eec77a', blue: '#a9d6ff', magenta: '#d5a7ef', cyan: '#71d6d4', white: '#edf0f2', brightBlack: '#a5afb8', brightRed: '#ffa9af', brightGreen: '#9eeac5', brightYellow: '#ffdda0', brightBlue: '#c6e4ff', brightMagenta: '#e9c2ff', brightCyan: '#9ef3f0', brightWhite: '#ffffff' },
  light: { background: '#f7f9fa', foreground: '#202a32', cursor: '#2458d6', selectionBackground: '#d7e8ee', black: '#202a32', red: '#b32d42', green: '#197548', yellow: '#946214', blue: '#2466a4', magenta: '#7d4498', cyan: '#167374', white: '#52616c', brightBlack: '#5e6d77', brightRed: '#a3273b', brightGreen: '#126438', brightYellow: '#81500e', brightBlue: '#19588f', brightMagenta: '#693780', brightCyan: '#0c6465', brightWhite: '#202a32' },
};
