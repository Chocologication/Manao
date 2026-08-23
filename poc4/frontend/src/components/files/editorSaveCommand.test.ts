import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceBufferRegistry } from '../../app/appRuntime';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { projectAuthorityScope } from '../../features/files/fileMutations';
import { fileKeys, useDirectoryTreeQuery } from '../../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../../features/files/pathPolicy';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import {
  editorKindForRenderMode,
  ensureWorkspaceBuffer,
  isSaveEnabled,
  prepareEditorSave,
  projectFileWritePredicate,
  replacePlainTextContent,
  SAVE_SUCCESS_STATUS_MS,
  useEditorSaveCommand,
} from './editorSaveCommand';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');
const NOTES = parseProjectRelativePath('docs/large-notes.md');
const ROOT = parseProjectDirectoryPath('');

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function seedRootRevision(): Promise<void> {
  workspaceSessionStore.getState().activateProject(ALICE_SEED_PROJECT_ID);
  const { result } = renderHook(() => useDirectoryTreeQuery(ALICE_SEED_PROJECT_ID, ROOT), {
    wrapper: AppProviders,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
}

function registerPlain(path: typeof POM, content: string) {
  return workspaceBufferRegistry.register({
    projectId: ALICE_SEED_PROJECT_ID,
    path,
    kind: 'plain-text',
    content,
  });
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  disposeAllProjectModels();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('editorKindForRenderMode', () => {
  it('maps writable modes and never treats BLOCKED as a buffer kind', () => {
    expect(editorKindForRenderMode('MONACO_TEXT')).toBe('monaco');
    expect(editorKindForRenderMode('PLAIN_TEXT')).toBe('plain-text');
    expect(editorKindForRenderMode('BLOCKED')).toBeNull();
  });
});

describe('isSaveEnabled', () => {
  it('is only enabled for a dirty buffer when the project write is idle', () => {
    expect(isSaveEnabled({ dirty: true, writePending: false })).toBe(true);
    expect(isSaveEnabled({ dirty: false, writePending: false })).toBe(false);
    expect(isSaveEnabled({ dirty: true, writePending: true })).toBe(false);
    expect(isSaveEnabled({ dirty: false, writePending: true })).toBe(false);
  });
});

describe('prepareEditorSave', () => {
  it('returns null when pending, missing, or clean', () => {
    const mutate = vi.fn();
    expect(
      prepareEditorSave({
        projectId: ALICE_SEED_PROJECT_ID,
        path: POM,
        writePending: true,
        mutate,
      }),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();

    expect(
      prepareEditorSave({
        projectId: ALICE_SEED_PROJECT_ID,
        path: POM,
        writePending: false,
        mutate,
      }),
    ).toBeNull();

    registerPlain(POM, '<project />');
    expect(
      prepareEditorSave({
        projectId: ALICE_SEED_PROJECT_ID,
        path: POM,
        writePending: false,
        mutate,
      }),
    ).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('captures the snapshot before mutate so a later edit is not submitted', () => {
    const buffer = registerPlain(POM, '<project />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project edited />');
    const mutate = vi.fn();

    const request = prepareEditorSave({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      writePending: false,
      mutate,
    });

    expect(request).toEqual({
      path: POM,
      snapshot: { content: '<project edited />', version: 1 },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(request);

    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project later />');
    expect(request?.snapshot).toEqual({ content: '<project edited />', version: 1 });
    expect(buffer.snapshot().content).toBe('<project later />');
    expect(buffer.isDirty()).toBe(true);
  });
});

describe('ensureWorkspaceBuffer', () => {
  it('registers once and keeps the same adapter on remount', () => {
    const first = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'plain-text',
      content: '# notes',
    });
    const second = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'plain-text',
      content: '# ignored remount seed',
    });

    expect(second).toBe(first);
    expect(first.snapshot().content).toBe('# notes');
  });

  it('disposes a mismatched adapter only when seeding the next renderer', () => {
    const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, NOTES);
    const model = monaco.editor.createModel('# notes', 'markdown', uri);
    const monacoBuffer = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'monaco',
      model,
    });

    const next = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'plain-text',
      content: monacoBuffer.snapshot().content,
    });

    expect(next.kind).toBe('plain-text');
    expect(next.snapshot().content).toBe('# notes');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, NOTES)).toBe(next);
    expect(monaco.editor.getModel(uri)).toBeNull();
    expect(monacoBuffer.isDirty()).toBe(false);
  });

  it('seeds the next renderer from the submitted snapshot and keeps leftover edits dirty', () => {
    const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, NOTES);
    const model = monaco.editor.createModel('# submitted', 'markdown', uri);
    ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'monaco',
      model,
    });
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: '# later' }], () => null);

    const next = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: NOTES,
      kind: 'plain-text',
      content: '# submitted',
    });

    expect(next.kind).toBe('plain-text');
    expect(next.snapshot().content).toBe('# later');
    expect(next.isDirty()).toBe(true);
    expect(monaco.editor.getModel(uri)).toBeNull();

    const monacoUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    registerPlain(POM, '<submitted />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<later />');
    const seeded = monaco.editor.createModel('<submitted />', 'xml', monacoUri);
    const afterPlain = ensureWorkspaceBuffer({
      projectId: ALICE_SEED_PROJECT_ID,
      path: POM,
      kind: 'monaco',
      model: seeded,
    });

    expect(afterPlain.kind).toBe('monaco');
    expect(afterPlain.snapshot().content).toBe('<later />');
    expect(afterPlain.isDirty()).toBe(true);
  });
});

describe('projectFileWritePredicate', () => {
  it('matches only the project-authority scope id', () => {
    const predicate = projectFileWritePredicate(ALICE_SEED_PROJECT_ID);
    expect(predicate({ options: { scope: projectAuthorityScope(ALICE_SEED_PROJECT_ID) } })).toBe(
      true,
    );
    expect(predicate({ options: { scope: projectAuthorityScope('other-project') } })).toBe(false);
    expect(predicate({ options: {} })).toBe(false);
  });
});

describe('useEditorSaveCommand', () => {
  it('keeps the buffer on failure and stays dirty when edited after the captured snapshot', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const buffer = registerPlain(POM, '<project />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project edited />');
    const requestSnapshot = buffer.snapshot();

    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Mock save failure', traceId: 'trace-save' },
          { status: 500 },
        );
      }),
    );

    const { result } = renderHook(() => useEditorSaveCommand(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    result.current.savePath(POM);
    await waitFor(() => expect(result.current.feedback?.kind).toBe('alert'));
    expect(result.current.feedback).toEqual({
      path: POM,
      kind: 'alert',
      message: 'Unable to save file',
    });
    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot()).toEqual(requestSnapshot);
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBe('mock-rev-0001');
  });

  it('marks only the captured snapshot so a later in-flight edit stays dirty', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    const buffer = registerPlain(POM, '<project />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project edited />');

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        await gate;
        return undefined;
      }),
    );

    const { result } = renderHook(() => useEditorSaveCommand(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    result.current.savePath(POM);
    await waitFor(() => expect(result.current.writePending).toBe(true));
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project later />');
    release();

    await waitFor(() =>
      expect(result.current.feedback).toEqual({ path: POM, kind: 'status', message: 'Saved' }),
    );
    expect(buffer.isDirty()).toBe(true);
    expect(buffer.snapshot().content).toBe('<project later />');
  });

  it('does not start a second save while the project write is pending', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    registerPlain(POM, '<project />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project edited />');

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let puts = 0;
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async () => {
        puts += 1;
        await gate;
        return undefined;
      }),
    );

    const { result } = renderHook(() => useEditorSaveCommand(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    result.current.savePath(POM);
    await waitFor(() => expect(result.current.writePending).toBe(true));
    result.current.savePath(POM);
    result.current.savePath(POM);
    expect(puts).toBe(1);

    release();
    await waitFor(() => expect(result.current.writePending).toBe(false));
    expect(puts).toBe(1);
    expect(result.current.feedback).toEqual({ path: POM, kind: 'status', message: 'Saved' });
  });

  it('clears a Saved status after the brief delay', async () => {
    await authenticateAsAlice();
    await seedRootRevision();
    registerPlain(POM, '<project />');
    replacePlainTextContent(ALICE_SEED_PROJECT_ID, POM, '<project edited />');

    const { result } = renderHook(() => useEditorSaveCommand(ALICE_SEED_PROJECT_ID), {
      wrapper: AppProviders,
    });

    result.current.savePath(POM);
    await waitFor(() =>
      expect(result.current.feedback).toEqual({ path: POM, kind: 'status', message: 'Saved' }),
    );
    await waitFor(
      () => {
        expect(result.current.feedback).toBeNull();
      },
      { timeout: SAVE_SUCCESS_STATUS_MS + 500 },
    );
  });
});
