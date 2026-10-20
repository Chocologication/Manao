import { useEffect, useState } from 'react';
import { create } from 'zustand';

const key = 'manao.motion.v1';
function read() { try { return localStorage.getItem(key) !== 'off'; } catch { return true; } }
export const useMotionPreferences = create<{ enabled: boolean; setEnabled: (enabled: boolean) => void }>((set) => ({
  enabled: read(),
  setEnabled: (enabled) => {
    try { localStorage.setItem(key, enabled ? 'on' : 'off'); } catch { /* Preference remains effective in this tab. */ }
    set({ enabled });
  },
}));

export function useReducedMotion() {
  const enabled = useMotionPreferences((state) => state.enabled);
  const [systemReduced, setSystemReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const update = () => setSystemReduced(media?.matches ?? false);
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, []);
  return !enabled || systemReduced;
}

export function subscribeToMotionChanges() {
  const apply = () => { document.documentElement.dataset.motion = useMotionPreferences.getState().enabled ? 'on' : 'off'; };
  apply();
  const unsubscribe = useMotionPreferences.subscribe(apply);
  const sync = (event: StorageEvent) => {
    if (event.key === key || event.key === null) useMotionPreferences.setState({ enabled: read() });
  };
  window.addEventListener('storage', sync);
  return () => { unsubscribe(); window.removeEventListener('storage', sync); };
}
