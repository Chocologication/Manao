import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Each hook stays scoped to its current storage key, including account switches.
export function useLocalPreferences<T>(key: string, defaults: T, parse: (value: unknown) => T) {
  const read = useCallback(() => {
    try { return parse(JSON.parse(localStorage.getItem(key) ?? 'null')); }
    catch { return defaults; }
  }, [defaults, key, parse]);
  const initial = useMemo(read, [read]);
  const [record, setRecord] = useState(() => ({ key, value: initial }));
  const value = record.key === key ? record.value : initial;
  const latest = useRef({ key, value });
  if (latest.current.key !== key) latest.current = { key, value: initial };
  useEffect(() => {
    const refresh = (event: StorageEvent | Event) => {
      if (event instanceof StorageEvent && event.key !== key && event.key !== null) return;
      latest.current = { key, value: read() };
      setRecord(latest.current);
    };
    window.addEventListener('storage', refresh);
    window.addEventListener(`manao:preference:${key}`, refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener(`manao:preference:${key}`, refresh); };
  }, [key, read]);
  const update = useCallback((patch: Partial<T>) => {
    const next = parse({ ...latest.current.value, ...patch });
    latest.current = { key, value: next };
    setRecord(latest.current);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event(`manao:preference:${key}`));
    } catch { /* In-memory preferences remain available. */ }
  }, [key, parse]);
  return { value, update, reset: () => update(defaults) };
}
