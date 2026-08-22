import { ChevronRight } from 'lucide-react';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { FileTreeEntry, ProjectRelativePath } from '@/contracts/file';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import {
  fileQueryErrorMessage,
  sortFileTreeEntries,
  useDirectoryTreeQuery,
} from '@/features/files/fileQueries';
import { cn } from '@/lib/utils';
import { getFileIcon, getFileIconColor } from './fileIcons';

function rowClassName(isSelected: boolean): string {
  return cn(
    'flex h-7 cursor-pointer select-none items-center gap-1 rounded-sm px-2 text-sm hover:bg-accent/50',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring',
    isSelected && 'bg-accent text-accent-foreground',
  );
}

export function FileTreeNode({
  projectId,
  entry,
  depth,
  tabbablePath,
  onFocusedPath,
}: {
  projectId: string;
  entry: FileTreeEntry;
  depth: number;
  tabbablePath: ProjectRelativePath | null;
  onFocusedPath: (path: ProjectRelativePath) => void;
}) {
  if (entry.kind === 'directory') {
    return (
      <DirectoryTreeNode
        projectId={projectId}
        entry={entry}
        depth={depth}
        tabbablePath={tabbablePath}
        onFocusedPath={onFocusedPath}
      />
    );
  }
  return (
    <FileTreeLeaf
      entry={entry}
      depth={depth}
      tabbablePath={tabbablePath}
      onFocusedPath={onFocusedPath}
    />
  );
}

function DirectoryTreeNode({
  projectId,
  entry,
  depth,
  tabbablePath,
  onFocusedPath,
}: {
  projectId: string;
  entry: FileTreeEntry;
  depth: number;
  tabbablePath: ProjectRelativePath | null;
  onFocusedPath: (path: ProjectRelativePath) => void;
}) {
  const isExpanded = useWorkspaceSession((state) => state.expandedPaths.has(entry.path));
  const isSelected = useWorkspaceSession((state) => state.selectedPath === entry.path);
  const toggleDirectory = useWorkspaceSession((state) => state.toggleDirectory);
  const query = useDirectoryTreeQuery(projectId, entry.path);
  const isFocused = tabbablePath === entry.path;
  const isLoading = isExpanded && query.isPending;
  const Icon = getFileIcon(entry.name, true, isExpanded);
  const iconColor = getFileIconColor(entry.name, true);
  const children = query.data ? sortFileTreeEntries(query.data.entries) : [];

  return (
    <>
      <div
        role="treeitem"
        aria-label={entry.name}
        aria-expanded={isExpanded}
        aria-selected={isSelected}
        aria-level={depth + 1}
        tabIndex={isFocused ? 0 : -1}
        data-path={entry.path}
        data-kind="directory"
        className={rowClassName(isSelected)}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={(event) => {
          event.stopPropagation();
          onFocusedPath(entry.path);
          toggleDirectory(entry.path);
        }}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          onFocusedPath(entry.path);
        }}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            isExpanded && 'rotate-90',
          )}
          aria-hidden
        />
        {isLoading ? (
          <Spinner />
        ) : (
          <Icon className={cn('h-4 w-4 shrink-0', iconColor)} aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </div>
      {isExpanded ? (
        <div role="group">
          {query.isError ? (
            <div
              className="flex flex-col items-start gap-2 py-1 pr-2"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              <InlineAlert>
                {fileQueryErrorMessage(query.error, 'Unable to load directory')}
              </InlineAlert>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {query.data && children.length === 0 ? (
            <p
              className="py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              Empty
            </p>
          ) : null}
          {children.map((child) => (
            <FileTreeNode
              key={child.path}
              projectId={projectId}
              entry={child}
              depth={depth + 1}
              tabbablePath={tabbablePath}
              onFocusedPath={onFocusedPath}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function FileTreeLeaf({
  entry,
  depth,
  tabbablePath,
  onFocusedPath,
}: {
  entry: FileTreeEntry;
  depth: number;
  tabbablePath: ProjectRelativePath | null;
  onFocusedPath: (path: ProjectRelativePath) => void;
}) {
  const isSelected = useWorkspaceSession((state) => state.selectedPath === entry.path);
  const selectPath = useWorkspaceSession((state) => state.selectPath);
  const openFile = useWorkspaceSession((state) => state.openFile);
  const isFocused = tabbablePath === entry.path;
  const Icon = getFileIcon(entry.name, false);
  const iconColor = getFileIconColor(entry.name, false);

  return (
    <div
      role="treeitem"
      aria-label={entry.name}
      aria-selected={isSelected}
      aria-level={depth + 1}
      tabIndex={isFocused ? 0 : -1}
      data-path={entry.path}
      data-kind="file"
      className={rowClassName(isSelected)}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      onClick={(event) => {
        event.stopPropagation();
        onFocusedPath(entry.path);
        selectPath(entry.path);
        openFile(entry.path);
      }}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        onFocusedPath(entry.path);
      }}
    >
      <span className="w-4 shrink-0" />
      <Icon className={cn('h-4 w-4 shrink-0', iconColor)} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </div>
  );
}
