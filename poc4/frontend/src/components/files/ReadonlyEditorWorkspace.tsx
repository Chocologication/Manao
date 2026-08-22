import { useCallback, useEffect, useRef } from 'react';
import { workspaceResourceRegistry } from '@/app/appRuntime';
import { InlineAlert } from '@/components/feedback/InlineAlert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { ProjectRelativePath } from '@/contracts/file';
import type { EditorTab } from '@/features/editor/editorTypes';
import { useWorkspaceSession } from '@/features/editor/workspaceSession';
import {
  fileQueryErrorMessage,
  useFileContentQuery,
  useFileMetadataQuery,
} from '@/features/files/fileQueries';
import { parseProjectRelativePath } from '@/features/files/pathPolicy';
import { languageForFile } from '@/lib/languageForFile';
import {
  disposeAllProjectModels,
  disposeProjectModel,
  disposeProjectModels,
} from '@/lib/projectMonacoModels';
import { BlockedFileView } from './BlockedFileView';
import { EditorTabs } from './EditorTabs';
import { PlainTextViewer } from './PlainTextViewer';
import { ReadonlyMonacoEditor } from './ReadonlyMonacoEditor';

function fileName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

function FileStatus({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex h-full items-center justify-center p-3">
      <Spinner />
    </div>
  );
}

function FileRequestError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-3">
      <InlineAlert>{message}</InlineAlert>
      <Button type="button" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function FileQuerySubscription({
  projectId,
  path,
}: {
  projectId: string;
  path: ProjectRelativePath;
}) {
  const meta = useFileMetadataQuery(projectId, path, true);
  useFileContentQuery(projectId, path, meta.data?.renderMode);
  return null;
}

function ActiveFileSurface({
  projectId,
  path,
}: {
  projectId: string;
  path: ProjectRelativePath;
}) {
  const meta = useFileMetadataQuery(projectId, path, true);
  const content = useFileContentQuery(projectId, path, meta.data?.renderMode);

  if (meta.isPending) {
    return <FileStatus label="Loading file metadata" />;
  }
  if (meta.isError) {
    return (
      <FileRequestError
        message={fileQueryErrorMessage(meta.error, 'Unable to load file metadata')}
        onRetry={() => {
          void meta.refetch();
        }}
      />
    );
  }
  if (meta.data === undefined) {
    return null;
  }

  if (meta.data.renderMode === 'BLOCKED') {
    return <BlockedFileView key={meta.data.path} projectId={projectId} metadata={meta.data} />;
  }

  if (content.isPending) {
    return <FileStatus label="Loading file content" />;
  }
  if (content.isError) {
    return (
      <FileRequestError
        message={fileQueryErrorMessage(content.error, 'Unable to load file content')}
        onRetry={() => {
          void content.refetch();
        }}
      />
    );
  }
  if (content.data === undefined) {
    return null;
  }

  if (meta.data.renderMode === 'PLAIN_TEXT') {
    return <PlainTextViewer metadata={meta.data} content={content.data.content} />;
  }

  return (
    <ReadonlyMonacoEditor
      projectId={projectId}
      path={path}
      content={content.data.content}
      language={meta.data.language || languageForFile(path)}
    />
  );
}

export function ReadonlyEditorWorkspace({ projectId }: { projectId: string }) {
  const sessionProjectId = useWorkspaceSession((state) => state.projectId);
  const openPaths = useWorkspaceSession((state) => state.openPaths);
  const activePath = useWorkspaceSession((state) => state.activePath);
  const aligned = sessionProjectId === projectId;
  const visibleOpenPaths = aligned ? openPaths : [];
  const visibleActivePath = aligned ? activePath : null;
  const pendingDisposeRef = useRef<ProjectRelativePath[]>([]);
  const previousProjectIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unregister = workspaceResourceRegistry.register(disposeAllProjectModels);
    return () => {
      unregister();
    };
  }, []);

  useEffect(() => {
    const previous = previousProjectIdRef.current;
    previousProjectIdRef.current = projectId;
    if (previous !== null && previous !== projectId) {
      pendingDisposeRef.current = [];
      disposeProjectModels(previous);
    }
  }, [projectId]);

  const handleSelect = useCallback((path: string) => {
    const relative = parseProjectRelativePath(path);
    const session = useWorkspaceSession.getState();
    session.selectPath(relative);
    session.openFile(relative);
  }, []);

  const handleClose = useCallback((path: string) => {
    const relative = parseProjectRelativePath(path);
    pendingDisposeRef.current.push(relative);
    useWorkspaceSession.getState().closeFile(relative);
  }, []);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    useWorkspaceSession.getState().reorderTabs(fromIndex, toIndex);
  }, []);

  useEffect(() => {
    const pending = pendingDisposeRef.current;
    if (pending.length === 0) {
      return;
    }
    const stillPending: ProjectRelativePath[] = [];
    pendingDisposeRef.current = [];
    for (const path of pending) {
      if (path === visibleActivePath) {
        stillPending.push(path);
      } else {
        disposeProjectModel(projectId, path);
      }
    }
    pendingDisposeRef.current = stillPending;
  }, [projectId, visibleActivePath, visibleOpenPaths]);

  const tabs: EditorTab[] = visibleOpenPaths.map((path) => ({
    path,
    title: fileName(path),
    isDirty: false,
  }));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <EditorTabs
        tabs={tabs}
        activePath={visibleActivePath}
        onSelect={handleSelect}
        onClose={handleClose}
        onReorder={handleReorder}
      />
      <div className="min-h-0 min-w-0 flex-1">
        {visibleOpenPaths.map((path) =>
          path === visibleActivePath ? null : (
            <FileQuerySubscription key={path} projectId={projectId} path={path} />
          ),
        )}
        {visibleActivePath !== null ? (
          <ActiveFileSurface projectId={projectId} path={visibleActivePath} />
        ) : null}
      </div>
    </div>
  );
}
