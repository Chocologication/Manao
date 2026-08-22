import type { ProjectRelativePath } from '../../contracts/file';

export type EditorTab = {
  path: string;
  title: string;
  isDirty: boolean;
};

export type WorkspaceSessionState = {
  projectId: string | null;
  expandedPaths: Set<ProjectRelativePath>;
  selectedPath: ProjectRelativePath | null;
  openPaths: ProjectRelativePath[];
  activePath: ProjectRelativePath | null;
  activateProject(projectId: string): void;
  toggleDirectory(path: ProjectRelativePath): void;
  selectPath(path: ProjectRelativePath | null): void;
  openFile(path: ProjectRelativePath): void;
  closeFile(path: ProjectRelativePath): void;
  reorderTabs(fromIndex: number, toIndex: number): void;
  reset(): void;
};
