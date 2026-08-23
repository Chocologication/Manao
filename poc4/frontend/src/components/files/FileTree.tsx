import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { FilePlus, FolderPlus, RefreshCw, SquareMinus } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type {
  EntryKind,
  FileTreeResponse,
  ProjectDirectoryPath,
  ProjectRelativePath,
} from '@/contracts/file';
import { useUnsavedDialogState } from '@/features/editor/unsavedChangesGuard';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import { joinProjectPath } from '@/features/files/entryNamePolicy';
import {
  fileMutationErrorMessage,
  useCreateEntryMutation,
} from '@/features/files/fileMutations';
import {
  fileKeys,
  fileQueryErrorMessage,
  refreshProjectFiles,
  sortFileTreeEntries,
  useDirectoryTreeQuery,
} from '@/features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '@/features/files/pathPolicy';
import { FileMutationDialogs, type FileMutationDialogKind } from './FileMutationDialogs';
import { FileTreeNode } from './FileTreeNode';

function parentDirectory(path: ProjectRelativePath): ProjectDirectoryPath {
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    return '';
  }
  return parseProjectDirectoryPath(path.slice(0, slash));
}

function ancestorDirectories(path: ProjectRelativePath): ProjectRelativePath[] {
  const parts = path.split('/');
  const ancestors: ProjectRelativePath[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parseProjectRelativePath(parts.slice(0, index).join('/')));
  }
  return ancestors;
}

function expandPathChain(path: ProjectRelativePath): void {
  const session = useWorkspaceSession.getState();
  for (const ancestor of ancestorDirectories(path)) {
    if (!session.expandedPaths.has(ancestor)) {
      session.toggleDirectory(ancestor);
    }
  }
}

function lookupSelectedKind(
  queryClient: QueryClient,
  projectId: string,
  selectedPath: ProjectRelativePath | null,
  expandedPaths: Set<ProjectRelativePath>,
): EntryKind | null {
  if (selectedPath === null) {
    return null;
  }
  if (expandedPaths.has(selectedPath)) {
    return 'directory';
  }
  if (queryClient.getQueryData(fileKeys.meta(projectId, selectedPath)) !== undefined) {
    return 'file';
  }
  if (
    queryClient.getQueryData(fileKeys.tree(projectId, parseProjectDirectoryPath(selectedPath))) !==
    undefined
  ) {
    return 'directory';
  }
  const trees = queryClient.getQueriesData<FileTreeResponse>({
    queryKey: fileKeys.trees(projectId),
  });
  for (const [, data] of trees) {
    const entry = data?.entries.find((item) => item.path === selectedPath);
    if (entry !== undefined) {
      return entry.kind;
    }
  }
  return 'file';
}

function resolveCreateParent(
  queryClient: QueryClient,
  projectId: string,
  selectedPath: ProjectRelativePath | null,
  expandedPaths: Set<ProjectRelativePath>,
): ProjectDirectoryPath {
  if (selectedPath === null) {
    return parseProjectDirectoryPath('');
  }
  if (lookupSelectedKind(queryClient, projectId, selectedPath, expandedPaths) === 'directory') {
    return parseProjectDirectoryPath(selectedPath);
  }
  return parentDirectory(selectedPath);
}

function applyCreateSuccessUi(kind: EntryKind, path: ProjectRelativePath): void {
  expandPathChain(path);
  const session = useWorkspaceSession.getState();
  session.selectPath(path);
  if (kind === 'directory') {
    if (!session.expandedPaths.has(path)) {
      session.toggleDirectory(path);
    }
    return;
  }
  session.openFile(path);
}

function collapseAllDirectories(): void {
  const { expandedPaths, toggleDirectory } = useWorkspaceSession.getState();
  const snapshot = [...expandedPaths];
  const roots = snapshot.filter(
    (path) => !snapshot.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
  for (const path of roots) {
    if (useWorkspaceSession.getState().expandedPaths.has(path)) {
      toggleDirectory(path);
    }
  }
}

function isVisibleTreePath(
  path: ProjectRelativePath,
  expandedPaths: Set<ProjectRelativePath>,
): boolean {
  let start = 0;
  while (start < path.length) {
    const slash = path.indexOf('/', start);
    if (slash === -1) {
      return true;
    }
    const ancestor = path.slice(0, slash);
    if (!expandedPaths.has(ancestor as ProjectRelativePath)) {
      return false;
    }
    start = slash + 1;
  }
  return true;
}

function visibleAncestorPath(
  path: ProjectRelativePath,
  expandedPaths: Set<ProjectRelativePath>,
): ProjectRelativePath | null {
  if (isVisibleTreePath(path, expandedPaths)) {
    return path;
  }
  let ancestor: ProjectDirectoryPath = parentDirectory(path);
  while (ancestor !== '') {
    if (isVisibleTreePath(ancestor, expandedPaths)) {
      return ancestor;
    }
    ancestor = parentDirectory(ancestor);
  }
  return null;
}

function resolveTabbablePath(
  focusedPath: ProjectRelativePath | null,
  selectedPath: ProjectRelativePath | null,
  firstVisible: ProjectRelativePath | null,
  expandedPaths: Set<ProjectRelativePath>,
): ProjectRelativePath | null {
  if (focusedPath !== null) {
    const visible = visibleAncestorPath(focusedPath, expandedPaths);
    if (visible !== null) {
      return visible;
    }
  }
  if (selectedPath !== null) {
    const visible = visibleAncestorPath(selectedPath, expandedPaths);
    if (visible !== null) {
      return visible;
    }
  }
  return firstVisible;
}

const iconButtonClassName =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-64';

export function FileTree({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const rootQuery = useDirectoryTreeQuery(projectId, parseProjectDirectoryPath(''));
  const selectedPath = useWorkspaceSession((state) => state.selectedPath);
  const expandedPaths = useWorkspaceSession((state) => state.expandedPaths);
  const unsavedOpen = useUnsavedDialogState().open;
  const createMutation = useCreateEntryMutation(projectId);
  const [focusedPath, setFocusedPath] = useState<ProjectRelativePath | null>(null);
  const [createKind, setCreateKind] = useState<FileMutationDialogKind | null>(null);
  const entries = rootQuery.data ? sortFileTreeEntries(rootQuery.data.entries) : [];
  const tabbablePath = resolveTabbablePath(
    focusedPath,
    selectedPath,
    entries[0]?.path ?? null,
    expandedPaths,
  );
  const createPending = createMutation.isPending;

  useEffect(() => {
    if (selectedPath === null) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const node = document.querySelector(`[data-path="${CSS.escape(selectedPath)}"]`);
      if (!(node instanceof HTMLElement) || typeof node.scrollIntoView !== 'function') {
        return;
      }
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedPath]);

  const openCreateDialog = useCallback(
    (kind: FileMutationDialogKind) => {
      if (createMutation.isPending || unsavedOpen) {
        return;
      }
      createMutation.reset();
      setCreateKind(kind);
    },
    [createMutation, unsavedOpen],
  );

  const closeCreateDialog = useCallback(() => {
    setCreateKind(null);
    if (!createMutation.isPending) {
      createMutation.reset();
    }
  }, [createMutation]);

  const submitCreate = useCallback(
    (basename: string) => {
      if (createKind === null || createMutation.isPending) {
        return;
      }
      const session = useWorkspaceSession.getState();
      const parent = resolveCreateParent(
        queryClient,
        projectId,
        session.selectedPath,
        session.expandedPaths,
      );
      const kind: EntryKind = createKind === 'create-folder' ? 'directory' : 'file';
      let path: ProjectRelativePath;
      try {
        path = joinProjectPath(parent, basename);
      } catch {
        return;
      }
      void createMutation
        .mutateAsync({ kind, path })
        .then(() => {
          applyCreateSuccessUi(kind, path);
          setCreateKind(null);
          createMutation.reset();
        })
        .catch(() => {});
    },
    [createKind, createMutation, projectId, queryClient],
  );

  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) {
      return;
    }
    const tree = event.currentTarget;
    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (current === null || !tree.contains(current)) {
      return;
    }
    const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = items.indexOf(current);
    const rawPath = current.dataset.path;
    const kind = current.dataset.kind;
    if (rawPath === undefined || index === -1) {
      return;
    }
    const path = parseProjectRelativePath(rawPath);
    const session = useWorkspaceSession.getState();

    if (event.key === 'Enter') {
      event.preventDefault();
      if (kind === 'directory') {
        session.selectPath(path);
        session.toggleDirectory(path);
      } else {
        session.selectPath(path);
        session.openFile(path);
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (kind !== 'directory') {
        return;
      }
      if (!session.expandedPaths.has(path)) {
        session.toggleDirectory(path);
        return;
      }
      const next = items[index + 1];
      if (next?.dataset.path?.startsWith(`${path}/`)) {
        next.focus();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (kind === 'directory' && session.expandedPaths.has(path)) {
        session.toggleDirectory(path);
        return;
      }
      const parent = parentDirectory(path);
      if (parent === '') {
        return;
      }
      const parentItem = items.find((item) => item.dataset.path === parent);
      parentItem?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[index + 1]?.focus();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[index - 1]?.focus();
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-end gap-1 border-b bg-background px-2">
        <button
          type="button"
          title="New file"
          aria-label="New file"
          className={iconButtonClassName}
          disabled={createPending}
          onClick={() => {
            openCreateDialog('create-file');
          }}
        >
          <FilePlus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="New folder"
          aria-label="New folder"
          className={iconButtonClassName}
          disabled={createPending}
          onClick={() => {
            openCreateDialog('create-folder');
          }}
        >
          <FolderPlus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh"
          className={iconButtonClassName}
          onClick={() => {
            void refreshProjectFiles(queryClient, projectId);
          }}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          title="Collapse all folders"
          aria-label="Collapse all folders"
          className={iconButtonClassName}
          onClick={() => {
            collapseAllDirectories();
          }}
        >
          <SquareMinus className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rootQuery.isPending ? (
          <div role="status" aria-label="Loading files" className="flex justify-center p-3">
            <Spinner />
          </div>
        ) : null}
        {rootQuery.isError ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <InlineAlert>
              {fileQueryErrorMessage(rootQuery.error, 'Unable to load files')}
            </InlineAlert>
            <Button type="button" variant="outline" onClick={() => void rootQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {rootQuery.data ? (
          <div
            role="tree"
            aria-label="Files"
            className="pb-4 outline-none"
            onKeyDown={onTreeKeyDown}
          >
            {entries.map((entry) => (
              <FileTreeNode
                key={entry.path}
                projectId={projectId}
                entry={entry}
                depth={0}
                tabbablePath={tabbablePath}
                onFocusedPath={setFocusedPath}
              />
            ))}
          </div>
        ) : null}
      </div>
      <FileMutationDialogs
        open={createKind !== null}
        kind={createKind}
        pending={createPending}
        errorMessage={
          createKind !== null && createMutation.isError
            ? fileMutationErrorMessage(createMutation.error)
            : null
        }
        onSubmit={submitCreate}
        onCancel={closeCreateDialog}
      />
    </div>
  );
}
