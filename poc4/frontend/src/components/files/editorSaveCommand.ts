import { useIsMutating } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { FileRenderMode, ProjectRelativePath } from '@/contracts/file';
import type { WorkspaceBuffer } from '@/features/editor/editorTypes';
import type { RegisterWorkspaceBufferInput } from '@/features/editor/WorkspaceBufferRegistry';
import {
  fileMutationErrorMessage,
  projectAuthorityScope,
  useSaveFileMutation,
  type SaveFileVariables,
} from '@/features/files/fileMutations';

export const SAVE_SUCCESS_STATUS_MS = 2000;

export type EditorSaveFeedback = {
  path: ProjectRelativePath;
  kind: 'status' | 'alert';
  message: string;
};

export type EditorSavePathResult =
  | { status: 'saved' }
  | { status: 'failed'; message: string }
  | { status: 'skipped' };

type PlainTextMutableBuffer = WorkspaceBuffer & { replace(content: string): void };

export function editorKindForRenderMode(
  mode: FileRenderMode,
): 'monaco' | 'plain-text' | null {
  if (mode === 'MONACO_TEXT') {
    return 'monaco';
  }
  if (mode === 'PLAIN_TEXT') {
    return 'plain-text';
  }
  return null;
}

export function isSaveEnabled({
  dirty,
  writePending,
}: {
  dirty: boolean;
  writePending: boolean;
}): boolean {
  return dirty && !writePending;
}

export function projectFileWritePredicate(projectId: string) {
  const scopeId = projectAuthorityScope(projectId).id;
  return (mutation: { options: { scope?: { id?: string } } }) => mutation.options.scope?.id === scopeId;
}

export function replacePlainTextContent(
  projectId: string,
  path: ProjectRelativePath,
  content: string,
): void {
  const buffer = workspaceBufferRegistry.get(projectId, path);
  if (buffer === undefined || buffer.kind !== 'plain-text') {
    return;
  }
  (buffer as PlainTextMutableBuffer).replace(content);
}

export function ensureWorkspaceBuffer(input: RegisterWorkspaceBufferInput): WorkspaceBuffer {
  const existing = workspaceBufferRegistry.get(input.projectId, input.path);
  if (existing !== undefined && existing.kind === input.kind) {
    return existing;
  }
  let leftover: string | undefined;
  if (existing !== undefined) {
    leftover = existing.snapshot().content;
    workspaceBufferRegistry.remove(input.projectId, input.path);
  }
  const next = workspaceBufferRegistry.register(input);
  if (leftover !== undefined && leftover !== next.snapshot().content) {
    if (input.kind === 'plain-text') {
      replacePlainTextContent(input.projectId, input.path, leftover);
    } else {
      input.model.setValue(leftover);
    }
  }
  return next;
}

export function prepareEditorSave(options: {
  projectId: string;
  path: ProjectRelativePath;
  writePending: boolean;
  mutate: (variables: SaveFileVariables) => void;
}): SaveFileVariables | null {
  if (options.writePending) {
    return null;
  }
  const buffer = workspaceBufferRegistry.get(options.projectId, options.path);
  if (buffer === undefined || !buffer.isDirty()) {
    return null;
  }
  const request: SaveFileVariables = {
    path: options.path,
    snapshot: buffer.snapshot(),
  };
  options.mutate(request);
  return request;
}

export function useEditorSaveCommand(projectId: string) {
  const mutation = useSaveFileMutation(projectId);
  const writePending =
    useIsMutating({
      predicate: projectFileWritePredicate(projectId),
    }) > 0;
  const inFlightRef = useRef(false);
  const [feedback, setFeedback] = useState<EditorSaveFeedback | null>(null);

  const clearFeedback = useCallback(() => {
    setFeedback(null);
  }, []);

  useEffect(() => {
    if (feedback?.kind !== 'status' || feedback.message !== 'Saved') {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setFeedback((current) => {
        if (
          current?.kind === 'status' &&
          current.message === 'Saved' &&
          current.path === feedback.path
        ) {
          return null;
        }
        return current;
      });
    }, SAVE_SUCCESS_STATUS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [feedback]);

  const savePath = useCallback(
    (path: ProjectRelativePath): Promise<EditorSavePathResult> => {
      return new Promise((resolve) => {
        if (inFlightRef.current) {
          resolve({ status: 'skipped' });
          return;
        }
        const request = prepareEditorSave({
          projectId,
          path,
          writePending,
          mutate: (variables) => {
            inFlightRef.current = true;
            setFeedback({ path, kind: 'status', message: 'Saving' });
            mutation.mutate(variables, {
              onSuccess: () => {
                setFeedback({ path, kind: 'status', message: 'Saved' });
                resolve({ status: 'saved' });
              },
              onError: (error) => {
                const message = fileMutationErrorMessage(error, 'Unable to save file');
                setFeedback({
                  path,
                  kind: 'alert',
                  message,
                });
                resolve({ status: 'failed', message });
              },
              onSettled: () => {
                inFlightRef.current = false;
              },
            });
          },
        });
        if (request === null) {
          resolve({ status: 'skipped' });
        }
      });
    },
    [mutation, projectId, writePending],
  );

  return { savePath, writePending, feedback, clearFeedback };
}
