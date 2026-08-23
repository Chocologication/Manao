import type { ProjectRelativePath } from '../../contracts/file';

export type EditorTab = {
  path: string;
  title: string;
  isDirty: boolean;
};

export type BufferSnapshot = {
  content: string;
  version: number;
};

export interface WorkspaceBuffer {
  readonly projectId: string;
  readonly path: ProjectRelativePath;
  readonly kind: 'monaco' | 'plain-text';
  snapshot(): BufferSnapshot;
  isDirty(): boolean;
  markSaved(snapshot: BufferSnapshot): void;
  discard(): void;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export type WorkspaceSessionState = {
  projectId: string | null;
  expandedPaths: Set<ProjectRelativePath>;
  selectedPath: ProjectRelativePath | null;
  openPaths: ProjectRelativePath[];
  activePath: ProjectRelativePath | null;
  dirtyPaths: Set<ProjectRelativePath>;
  activateProject(projectId: string): void;
  toggleDirectory(path: ProjectRelativePath): void;
  selectPath(path: ProjectRelativePath | null): void;
  openFile(path: ProjectRelativePath): void;
  closeFile(path: ProjectRelativePath): void;
  reorderTabs(fromIndex: number, toIndex: number): void;
  setDirty(path: ProjectRelativePath, dirty: boolean): void;
  remapPath(from: ProjectRelativePath, to: ProjectRelativePath): void;
  removePathAndDescendants(path: ProjectRelativePath): void;
  reset(): void;
};
