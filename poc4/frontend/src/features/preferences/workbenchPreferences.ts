import { create } from 'zustand';

type Preferences = { fileWidth: number; filesVisible: boolean; insightsVisible: boolean; focusMode: boolean };
export const defaultWorkbenchPreferences: Preferences = { fileWidth: 246, filesVisible: true, insightsVisible: true, focusMode: false };
const key = 'manao.workbench.layout.v1';
function parse(value: unknown): Preferences {
  const data = value && typeof value === 'object' ? value as Partial<Preferences> : {};
  return {
    fileWidth: typeof data.fileWidth === 'number' && Number.isFinite(data.fileWidth) ? Math.round(Math.min(340, Math.max(180, data.fileWidth))) : 246,
    filesVisible: typeof data.filesVisible === 'boolean' ? data.filesVisible : true,
    insightsVisible: typeof data.insightsVisible === 'boolean' ? data.insightsVisible : true,
    focusMode: typeof data.focusMode === 'boolean' ? data.focusMode : false,
  };
}
function read() { try { return parse(JSON.parse(localStorage.getItem(key) ?? 'null')); } catch { return defaultWorkbenchPreferences; } }
export const useWorkbenchPreferences = create<Preferences & { update: (value: Partial<Preferences>) => void; reset: () => void }>((set, get) => ({
  ...read(),
  update: (value) => {
    const next = parse({ ...get(), ...value });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* The current layout still works without storage. */ }
    set(next);
  },
  reset: () => get().update(defaultWorkbenchPreferences),
}));
