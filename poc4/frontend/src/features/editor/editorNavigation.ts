import { create } from 'zustand';
import type { ProjectRelativePath } from '@/contracts/file';

export type EditorLocation = { projectId: string; path: ProjectRelativePath; line: number; column: number };
export const useEditorNavigation = create<{
  target: EditorLocation | null;
  request: (target: EditorLocation) => void;
  clear: (target: EditorLocation) => void;
}>((set) => ({
  target: null,
  request: (target) => set({ target }),
  clear: (target) => set((state) => state.target === target ? { target: null } : {}),
}));
