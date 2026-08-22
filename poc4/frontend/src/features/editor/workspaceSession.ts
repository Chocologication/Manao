import { create } from 'zustand';
import type { ProjectRelativePath } from '../../contracts/file';
import type { WorkspaceSessionState } from './editorTypes';

export type { WorkspaceSessionState };

function isExpandedDescendant(parent: ProjectRelativePath, candidate: ProjectRelativePath): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export const useWorkspaceSession = create<WorkspaceSessionState>()((set, get, store) => ({
  projectId: null,
  expandedPaths: new Set<ProjectRelativePath>(),
  selectedPath: null,
  openPaths: [],
  activePath: null,
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
          if (!isExpandedDescendant(path, item)) {
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
  reset() {
    set(store.getInitialState());
  },
}));

export const workspaceSessionStore = {
  getState() {
    return useWorkspaceSession.getState();
  },
};
