import { create } from 'zustand';
import type { ProjectRelativePath } from '../../contracts/file';
import { parseProjectRelativePath } from '../files/pathPolicy';
import type { WorkspaceSessionState } from './editorTypes';

export type { WorkspaceSessionState };

function isSelfOrDescendant(parent: ProjectRelativePath, candidate: ProjectRelativePath): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function hasDirtySelfOrDescendant(
  dirtyPaths: ReadonlySet<ProjectRelativePath>,
  path: ProjectRelativePath,
): boolean {
  for (const dirty of dirtyPaths) {
    if (isSelfOrDescendant(path, dirty)) {
      return true;
    }
  }
  return false;
}

function remapRelativePath(
  from: ProjectRelativePath,
  to: ProjectRelativePath,
  path: ProjectRelativePath,
): ProjectRelativePath {
  if (path === from) {
    return to;
  }
  if (path.startsWith(`${from}/`)) {
    return parseProjectRelativePath(`${to}${path.slice(from.length)}`);
  }
  return path;
}

function remapSet(
  paths: Set<ProjectRelativePath>,
  from: ProjectRelativePath,
  to: ProjectRelativePath,
): { next: Set<ProjectRelativePath>; changed: boolean } {
  let changed = false;
  const next = new Set<ProjectRelativePath>();
  for (const item of paths) {
    const remapped = remapRelativePath(from, to, item);
    if (remapped !== item) {
      changed = true;
    }
    next.add(remapped);
  }
  return { next, changed };
}

function removeMatchingOpenPaths(
  openPaths: ProjectRelativePath[],
  activePath: ProjectRelativePath | null,
  match: (path: ProjectRelativePath) => boolean,
): { openPaths: ProjectRelativePath[]; activePath: ProjectRelativePath | null } {
  if (!openPaths.some(match) && (activePath === null || !match(activePath))) {
    return { openPaths, activePath };
  }
  const nextOpen = openPaths.filter((path) => !match(path));
  if (activePath === null || !match(activePath)) {
    return { openPaths: nextOpen, activePath };
  }
  const index = openPaths.indexOf(activePath);
  const after = openPaths.slice(index + 1).find((path) => !match(path));
  const before = [...openPaths.slice(0, index)].reverse().find((path) => !match(path));
  return { openPaths: nextOpen, activePath: after ?? before ?? null };
}

export const useWorkspaceSession = create<WorkspaceSessionState>()((set, get, store) => ({
  projectId: null,
  expandedPaths: new Set<ProjectRelativePath>(),
  selectedPath: null,
  openPaths: [],
  activePath: null,
  dirtyPaths: new Set<ProjectRelativePath>(),
  activateProject(projectId: string) {
    if (get().projectId === projectId) {
      return;
    }
    set({ ...store.getInitialState(), projectId });
  },
  toggleDirectory(path: ProjectRelativePath) {
    set((state) => {
      if (state.expandedPaths.has(path)) {
        const expandedPaths = new Set<ProjectRelativePath>();
        for (const item of state.expandedPaths) {
          if (!isSelfOrDescendant(path, item)) {
            expandedPaths.add(item);
          }
        }
        return { expandedPaths };
      }
      const expandedPaths = new Set(state.expandedPaths);
      expandedPaths.add(path);
      return { expandedPaths };
    });
  },
  selectPath(path: ProjectRelativePath | null) {
    set({ selectedPath: path });
  },
  openFile(path: ProjectRelativePath) {
    set((state) => {
      if (state.openPaths.includes(path)) {
        return { activePath: path };
      }
      return { openPaths: [...state.openPaths, path], activePath: path };
    });
  },
  closeFile(path: ProjectRelativePath) {
    set((state) => {
      const index = state.openPaths.indexOf(path);
      if (index === -1) {
        return {};
      }
      const openPaths = state.openPaths.filter((openPath) => openPath !== path);
      if (state.activePath !== path) {
        return { openPaths };
      }
      return {
        openPaths,
        activePath: openPaths[index] ?? openPaths[index - 1] ?? null,
      };
    });
  },
  reorderTabs(fromIndex: number, toIndex: number) {
    set((state) => {
      const lastIndex = state.openPaths.length - 1;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex > lastIndex ||
        toIndex > lastIndex
      ) {
        return {};
      }
      const openPaths = [...state.openPaths];
      const [moved] = openPaths.splice(fromIndex, 1);
      if (moved === undefined) {
        return {};
      }
      openPaths.splice(toIndex, 0, moved);
      return { openPaths };
    });
  },
  setDirty(path: ProjectRelativePath, dirty: boolean) {
    set((state) => {
      const has = state.dirtyPaths.has(path);
      if (has === dirty) {
        return {};
      }
      const dirtyPaths = new Set(state.dirtyPaths);
      if (dirty) {
        dirtyPaths.add(path);
      } else {
        dirtyPaths.delete(path);
      }
      return { dirtyPaths };
    });
  },
  remapPath(from: ProjectRelativePath, to: ProjectRelativePath) {
    if (from === to) {
      return;
    }
    set((state) => {
      const expanded = remapSet(state.expandedPaths, from, to);
      const dirty = remapSet(state.dirtyPaths, from, to);
      let openChanged = false;
      const openPaths = state.openPaths.map((path) => {
        const remapped = remapRelativePath(from, to, path);
        if (remapped !== path) {
          openChanged = true;
        }
        return remapped;
      });
      const selectedPath =
        state.selectedPath === null ? null : remapRelativePath(from, to, state.selectedPath);
      const activePath =
        state.activePath === null ? null : remapRelativePath(from, to, state.activePath);
      if (
        !expanded.changed &&
        !dirty.changed &&
        !openChanged &&
        selectedPath === state.selectedPath &&
        activePath === state.activePath
      ) {
        return {};
      }
      return {
        expandedPaths: expanded.next,
        dirtyPaths: dirty.next,
        openPaths,
        selectedPath,
        activePath,
      };
    });
  },
  removePathAndDescendants(path: ProjectRelativePath) {
    set((state) => {
      const match = (candidate: ProjectRelativePath) => isSelfOrDescendant(path, candidate);
      const expandedHit = [...state.expandedPaths].some(match);
      const dirtyHit = [...state.dirtyPaths].some(match);
      const selectedHit = state.selectedPath !== null && match(state.selectedPath);
      const tabs = removeMatchingOpenPaths(state.openPaths, state.activePath, match);
      if (
        !expandedHit &&
        !dirtyHit &&
        !selectedHit &&
        tabs.openPaths === state.openPaths &&
        tabs.activePath === state.activePath
      ) {
        return {};
      }
      return {
        expandedPaths: expandedHit
          ? new Set([...state.expandedPaths].filter((item) => !match(item)))
          : state.expandedPaths,
        dirtyPaths: dirtyHit
          ? new Set([...state.dirtyPaths].filter((item) => !match(item)))
          : state.dirtyPaths,
        openPaths: tabs.openPaths,
        activePath: tabs.activePath,
        selectedPath: selectedHit ? null : state.selectedPath,
      };
    });
  },
  reset() {
    set(store.getInitialState());
  },
}));

export const workspaceSessionStore = {
  getState() {
    return useWorkspaceSession.getState();
  },
};
