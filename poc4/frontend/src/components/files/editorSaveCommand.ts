import { useIsMutating } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { workspaceBufferRegistry } from '@/app/appRuntime';
import type { FileRenderMode, ProjectRelativePath } from '@/contracts/file';
import type { WorkspaceBuffer } from '@/features/editor/editorTypes';
import type { RegisterWorkspaceBufferInput } from '@/features/editor/WorkspaceBufferRegistry';
import {
  fileMutationErrorMessage,
  projectFileWriteScope,
  useSaveFileMutation,
  type SaveFileVariables,
} from '@/features/files/fileMutations';

export type EditorSaveFeedback =
  | { kind: 'status'; message: string }
  | { kind: 'alert'; message: string };

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
  const scopeId = projectFileWriteScope(projectId).id;
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
  if (existing !== undefined) {
    if (existing.kind === input.kind) {
      return existing;
    }
    workspaceBufferRegistry.remove(input.projectId, input.path);
  }
  return workspaceBufferRegistry.register(input);
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

  const savePath = useCallback(
    (path: ProjectRelativePath) => {
      if (inFlightRef.current) {
        return;
      }
      prepareEditorSave({
        projectId,
        path,
        writePending,
        mutate: (variables) => {
          inFlightRef.current = true;
          setFeedback({ kind: 'status', message: 'Saving' });
          mutation.mutate(variables, {
            onSuccess: () => {
              setFeedback({ kind: 'status', message: 'Saved' });
            },
            onError: (error) => {
              setFeedback({
                kind: 'alert',
                message: fileMutationErrorMessage(error, 'Unable to save file'),
              });
            },
            onSettled: () => {
              inFlightRef.current = false;
            },
          });
        },
      });
    },
    [mutation, projectId, writePending],
  );

  return { savePath, writePending, feedback };
}
