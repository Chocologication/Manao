import { create } from 'zustand';

type Preferences = { fontSize: number; wordWrap: boolean; minimap: boolean };
const defaults: Preferences = { fontSize: 14, wordWrap: false, minimap: false };
const key = 'manao.editor.preferences.v1';

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    return {
      fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? Math.min(24, Math.max(12, value.fontSize)) : defaults.fontSize,
      wordWrap: typeof value.wordWrap === 'boolean' ? value.wordWrap : defaults.wordWrap,
      minimap: typeof value.minimap === 'boolean' ? value.minimap : defaults.minimap,
    };
  } catch { return defaults; }
}

export const useEditorPreferences = create<Preferences & { update: (value: Partial<Preferences>) => void }>((set) => ({
  ...readPreferences(),
  update: (value) => set((current) => {
    const next = { fontSize: current.fontSize, wordWrap: current.wordWrap, minimap: current.minimap, ...value };
    next.fontSize = Math.min(24, Math.max(12, Number.isFinite(next.fontSize) ? next.fontSize : defaults.fontSize));
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Preferences remain usable when storage is unavailable. */ }
    return next;
  }),
}));
