import { useLocalPreferences } from '@/features/preferences/useLocalPreferences';

export type ProjectSort = 'newest' | 'oldest' | 'name' | 'visited';
type ProjectPreferences = { view: 'grid' | 'list'; sort: ProjectSort; favorites: string[]; visits: Record<string, number> };
const defaults: ProjectPreferences = { view: 'grid', sort: 'newest', favorites: [], visits: {} };
export const projectPreferencesKey = (userId: string) => `manao.projects.v1:${encodeURIComponent(userId)}`;

function parse(value: unknown): ProjectPreferences {
  if (!value || typeof value !== 'object') return defaults;
  const data = value as Partial<ProjectPreferences>;
  return {
    view: data.view === 'list' ? 'list' : 'grid',
    sort: ['newest', 'oldest', 'name', 'visited'].includes(data.sort ?? '') ? data.sort! : 'newest',
    favorites: Array.isArray(data.favorites) ? [...new Set(data.favorites.filter((id): id is string => typeof id === 'string' && id.length <= 256))].slice(0, 500) : [],
    visits: data.visits && typeof data.visits === 'object' ? Object.fromEntries(Object.entries(data.visits).filter(([id, time]) => id.length <= 256 && typeof time === 'number' && Number.isFinite(time) && time > 0).slice(-500)) : {},
  };
}

export function useProjectPreferences(userId: string) {
  return useLocalPreferences(projectPreferencesKey(userId), defaults, parse);
}

export function markProjectVisited(userId: string, projectId: string) {
  if (!userId || !projectId) return;
  const key = projectPreferencesKey(userId);
  try {
    const current = parse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    localStorage.setItem(key, JSON.stringify({ ...current, visits: { ...current.visits, [projectId]: Date.now() } }));
    window.dispatchEvent(new Event(`manao:preference:${key}`));
  } catch { /* Visits are optional local metadata. */ }
}
