import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import {
  authSession,
  queryClient,
  workspaceBufferRegistry,
  workspaceResourceRegistry,
} from '../../app/appRuntime';
import type { ProjectRelativePath } from '../../contracts/file';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import * as projectMonacoModels from '../../lib/projectMonacoModels';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import { getMockFile } from '../../mocks/fileFixtures';
import { server } from '../../mocks/node';
import {
  ALICE_SEED_PROJECT_ID,
  BOB_SEED_PROJECT_ID,
  getFileRequestCount,
  recordFileRequest,
} from '../../mocks/state';
import {
  CANCEL_LABEL,
  DISCARD_LABEL,
  REMAINING_CHANGES_MESSAGE,
  SAVE_AND_CLOSE_LABEL,
} from '../../features/editor/unsavedChangesGuard';
import { resetAppRuntime } from '../../test/renderApp';
import { EditorWorkspace } from './EditorWorkspace';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');
const APP = parseProjectRelativePath('src/main/java/demo/App.java');
const LARGE_NOTES = parseProjectRelativePath('docs/large-notes.md');
const TOO_LARGE = parseProjectRelativePath('docs/too-large.md');
const LOGO = parseProjectRelativePath('assets/logo.png');
const LATIN1 = parseProjectRelativePath('docs/latin1.txt');
const README = parseProjectRelativePath('README.md');

type FakeMonacoEditor = {
  addCommand(keybinding: number, handler: () => void): void;
  getModel(): monaco.editor.ITextModel | null;
};

type RecordedEditorProps = {
  path?: string;
  value?: string;
  defaultValue?: string;
  language?: string;
  keepCurrentModel?: boolean;
  saveViewState?: boolean;
  options?: {
    readOnly?: boolean;
    domReadOnly?: boolean;
    automaticLayout?: boolean;
    scrollBeyondLastLine?: boolean;
  };
  onChange?: unknown;
  onMount?: (editor: FakeMonacoEditor, monacoApi: typeof monaco) => void;
};

const recordedEditor = vi.hoisted(() => ({
  last: null as RecordedEditorProps | null,
  saveKeybinding: null as number | null,
  saveHandler: null as (() => void) | null,
}));

vi.mock('@monaco-editor/react', () => {
  function MockEditor(props: RecordedEditorProps) {
    recordedEditor.last = {
      path: props.path,
      value: props.value,
      defaultValue: props.defaultValue,
      language: props.language,
      keepCurrentModel: props.keepCurrentModel,
      saveViewState: props.saveViewState,
      options: props.options,
      onChange: props.onChange,
      onMount: props.onMount,
    };
    useEffect(() => {
      const modelPath = props.path;
      if (modelPath === undefined || modelPath === '') {
        return undefined;
      }
      const uri = monaco.Uri.parse(modelPath);
      if (monaco.editor.getModel(uri) === null) {
        monaco.editor.createModel(props.defaultValue ?? props.value ?? '', props.language, uri);
      }
      const editor: FakeMonacoEditor = {
        addCommand(keybinding, handler) {
          recordedEditor.saveKeybinding = keybinding;
          recordedEditor.saveHandler = handler;
        },
        getModel() {
          return monaco.editor.getModel(uri);
        },
      };
      props.onMount?.(editor, monaco);
      return () => {
        if (props.keepCurrentModel !== true) {
          monaco.editor.getModel(uri)?.dispose();
        }
      };
    }, [
      props.path,
      props.value,
      props.defaultValue,
      props.language,
      props.keepCurrentModel,
      props.onMount,
    ]);
    return createElement('div', {
      className: 'monaco-editor',
      'data-testid': 'mock-editor',
      'data-path': props.path ?? '',
    });
  }
  return {
    default: MockEditor,
    loader: {
      config() {},
      init: () => Promise.resolve({}),
    },
  };
});

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function renderWorkspace(projectId = ALICE_SEED_PROJECT_ID, writesLocked = false) {
  workspaceSessionStore.getState().activateProject(projectId);
  return render(
    <AppProviders>
      <EditorWorkspace projectId={projectId} writesLocked={writesLocked} />
    </AppProviders>,
  );
}

function openFile(path: ProjectRelativePath): void {
  workspaceSessionStore.getState().openFile(path);
}

function expectedFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ensureObjectUrlFns(): void {
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:http://localhost/mock',
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {},
    });
  }
}

function delayThenPassthrough(url: string, matchPath: string): { release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(url, async ({ request }) => {
      if (new URL(request.url).searchParams.get('path') === matchPath) {
        await gate;
      }
      return undefined;
    }),
  );
  return { release };
}

const originalClipboardItem = globalThis.ClipboardItem;

function editMonacoModel(projectId: string, path: ProjectRelativePath, text: string): void {
  const model = monaco.editor.getModel(toProjectModelUri(projectId, path));
  expect(model).not.toBeNull();
  model!.pushEditOperations([], [{ range: model!.getFullModelRange(), text }], () => null);
}

beforeEach(() => {
  recordedEditor.last = null;
  recordedEditor.saveKeybinding = null;
  recordedEditor.saveHandler = null;
  resetAppRuntime();
  globalThis.ClipboardItem = class {
    constructor(items: Record<string, Blob | string | Promise<Blob | string>> = {}) {
      for (const value of Object.values(items)) {
        void Promise.resolve(value).catch(() => {});
      }
    }
    static supports() {
      return false;
    }
  } as unknown as typeof ClipboardItem;
});

afterEach(async () => {
  globalThis.ClipboardItem = originalClipboardItem;
  cleanup();
  disposeAllProjectModels();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('EditorWorkspace metadata-gated views', () => {
  it('loads MONACO_TEXT as writable Monaco after exactly one metadata and one content request', async () => {
    const { release } = delayThenPassthrough(
      '/api/v1/projects/:projectId/files/meta',
      'pom.xml',
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    expect(await screen.findByRole('status', { name: 'Loading file metadata' })).toBeInTheDocument();
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
    expect(screen.queryByTestId('mock-editor')).not.toBeInTheDocument();

    release();

    expect(await screen.findByTestId('mock-editor')).toHaveClass('monaco-editor');
    expect(recordedEditor.last?.path).toBe(
      toProjectModelUri(ALICE_SEED_PROJECT_ID, POM).toString(),
    );
    expect(recordedEditor.last?.keepCurrentModel).toBe(true);
    expect(recordedEditor.last?.saveViewState).toBe(true);
    expect(recordedEditor.last?.value).toBeUndefined();
    expect(recordedEditor.last?.options).toEqual({
      readOnly: false,
      domReadOnly: false,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    expect(recordedEditor.last?.onChange).toBeUndefined();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
  });

  it('loads PLAIN_TEXT as an editable textarea and never mounts Monaco', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LARGE_NOTES);

    const textarea = await screen.findByRole('textbox');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).not.toHaveAttribute('readonly');
    expect(textarea).toHaveAttribute('wrap', 'off');
    expect(textarea).toHaveAttribute('spellcheck', 'false');
    expect(textarea).toHaveValue('# Large notes\n\nPlaceholder for the oversized Markdown fixture.\n');
    expect(screen.getByRole('tab', { name: /large-notes.md/ })).toBeInTheDocument();
    expect(
      screen.getByText(expectedFileSize(getMockFile(ALICE_SEED_PROJECT_ID, 'docs/large-notes.md')!.sizeBytes)),
    ).toBeInTheDocument();
    expect(screen.getByText('Plain text')).toBeInTheDocument();
    expect(document.querySelector('.monaco-editor')).toBeNull();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'docs/large-notes.md')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'docs/large-notes.md')).toBe(1);
  });

  it.each([
    {
      path: LOGO,
      rawPath: 'assets/logo.png',
      name: 'logo.png',
      mediaType: 'image/png',
      reason: /binary/i,
    },
    {
      path: TOO_LARGE,
      rawPath: 'docs/too-large.md',
      name: 'too-large.md',
      mediaType: 'text/markdown',
      reason: /too large/i,
    },
    {
      path: LATIN1,
      rawPath: 'docs/latin1.txt',
      name: 'latin1.txt',
      mediaType: 'text/plain',
      reason: /utf-8|encoding/i,
    },
  ])(
    'shows blocked metadata and Download for $rawPath without a content request',
    async ({ path, rawPath, name, mediaType, reason }) => {
      await authenticateAsAlice();
      renderWorkspace();
      openFile(path);

      expect(await screen.findByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeInTheDocument();
      expect(await screen.findByText(mediaType)).toBeInTheDocument();
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
      expect(
        screen.getByText(expectedFileSize(getMockFile(ALICE_SEED_PROJECT_ID, rawPath)!.sizeBytes)),
      ).toBeInTheDocument();
      expect(screen.getByText(reason)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
      expect(document.querySelector('.monaco-editor')).toBeNull();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, rawPath)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, rawPath)).toBe(0);
    },
  );

  it('does not leak blocked download error or in-flight state across files', async () => {
    const user = userEvent.setup();
    let releaseLogo = () => {};
    const logoGate = new Promise<void>((resolve) => {
      releaseLogo = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/download', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === 'assets/logo.png') {
          recordFileRequest('download', ALICE_SEED_PROJECT_ID, path);
          await logoGate;
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock download failure', traceId: 'trace-dl' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    ensureObjectUrlFns();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LOGO);
    const download = await screen.findByRole('button', { name: 'Download' });
    await user.click(download);
    expect(download).toBeDisabled();

    openFile(LATIN1);
    expect(await screen.findByText(/utf-8|encoding/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();

    releaseLogo();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });
});

describe('EditorWorkspace scoped loading and errors', () => {
  it('keeps metadata loading distinct from content loading', async () => {
    const metaGate = delayThenPassthrough(
      '/api/v1/projects/:projectId/files/meta',
      'pom.xml',
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    expect(await screen.findByRole('status', { name: 'Loading file metadata' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading file content' })).not.toBeInTheDocument();
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);

    const contentGate = delayThenPassthrough(
      '/api/v1/projects/:projectId/files/content',
      'pom.xml',
    );
    metaGate.release();

    expect(await screen.findByRole('status', { name: 'Loading file content' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading file metadata' })).not.toBeInTheDocument();
    contentGate.release();
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
  });

  it('retries a metadata error without requesting content until metadata succeeds', async () => {
    const user = userEvent.setup();
    let failMeta = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'pom.xml') {
          return undefined;
        }
        if (failMeta) {
          failMeta = false;
          recordFileRequest('meta', ALICE_SEED_PROJECT_ID, 'pom.xml');
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock meta failure', traceId: 'trace-meta' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load file metadata/i);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(2);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
  });

  it('retries a content error without duplicating the metadata request or tab', async () => {
    const user = userEvent.setup();
    let failContent = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/content', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'pom.xml') {
          return undefined;
        }
        if (failContent) {
          failContent = false;
          recordFileRequest('content', ALICE_SEED_PROJECT_ID, 'pom.xml');
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock content failure', traceId: 'trace-content' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load file content/i);
    expect(screen.getAllByRole('tab', { name: /pom.xml/ })).toHaveLength(1);
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(2);
    expect(screen.getAllByRole('tab', { name: /pom.xml/ })).toHaveLength(1);
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    await waitFor(() => {
      expect(monaco.editor.getModel(pomUri)).not.toBeNull();
    });
    expect(
      monaco.editor.getModels().filter((model) => model.uri.toString() === pomUri.toString()),
    ).toHaveLength(1);
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
  });
});

const OWNER_OR_PHYSICAL_LEAK = /bob|prj-bob|usr-bob|C:\\|D:\\|\/Users\/|\/etc\/|\/home\/|\/var\//;

describe('EditorWorkspace authorization and path errors', () => {
  it('shows generic access denied when Alice opens Bob file without leaking owner, project or path', async () => {
    await authenticateAsAlice();
    renderWorkspace(BOB_SEED_PROJECT_ID);
    openFile(parseProjectRelativePath('lab-notes.md'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/access denied/i);
    expect(alert).not.toHaveTextContent(OWNER_OR_PHYSICAL_LEAK);
    expect(alert).not.toHaveTextContent(/lab-notes/i);
    expect(document.body.textContent ?? '').not.toMatch(/prj-bob|usr-bob/i);
    expect(document.body.textContent ?? '').not.toMatch(/C:\\|\/Users\/|\/etc\//);
    expect(getFileRequestCount('content', BOB_SEED_PROJECT_ID, 'lab-notes.md')).toBe(0);
  });

  it('does not print physical server paths when metadata is INVALID_PATH', async () => {
    server.use(
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'pom.xml') {
          return undefined;
        }
        recordFileRequest('meta', ALICE_SEED_PROJECT_ID, 'pom.xml');
        return HttpResponse.json(
          {
            code: 'INVALID_PATH',
            message: 'Rejected C:\\Users\\alice\\repo\\pom.xml and /etc/passwd',
            traceId: 'trace-invalid-path',
          },
          { status: 400 },
        );
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unable to load file metadata/i);
    expect(alert).not.toHaveTextContent(/C:\\|\/Users\/|\/etc\//);
    expect(document.body.textContent ?? '').not.toMatch(/C:\\|\/Users\/|\/etc\//);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
  });
});

describe('EditorWorkspace retry isolation', () => {
  it('retries metadata without fetching content until metadata succeeds and without duplicating the tab', async () => {
    const user = userEvent.setup();
    let failMeta = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'pom.xml') {
          return undefined;
        }
        if (failMeta) {
          failMeta = false;
          recordFileRequest('meta', ALICE_SEED_PROJECT_ID, 'pom.xml');
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock meta failure', traceId: 'trace-meta-retry' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load file metadata/i);
    expect(screen.getAllByRole('tab', { name: /pom.xml/ })).toHaveLength(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'src/main/java/demo/App.java')).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(2);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'src/main/java/demo/App.java')).toBe(0);
    expect(screen.getAllByRole('tab', { name: /pom.xml/ })).toHaveLength(1);
  });
});

describe('EditorWorkspace tabs', () => {
  it('uses the final path segment as the label, full path as tooltip, and never marks dirty', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(APP);

    const tab = await screen.findByRole('tab', { name: /App.java/ });
    expect(tab).toHaveAttribute('title', 'src/main/java/demo/App.java');
    expect(tab).toHaveTextContent('App.java');
    expect(tab).not.toHaveTextContent('*');
    await screen.findByTestId('mock-editor');
  });

  it('reorders only Zustand tab state', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    openFile(APP);
    await screen.findByRole('tab', { name: /App.java/ });

    act(() => {
      workspaceSessionStore.getState().reorderTabs(0, 1);
    });

    expect(workspaceSessionStore.getState().openPaths).toEqual([APP, POM]);
    await waitFor(() => {
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveTextContent('App.java');
      expect(tabs[1]).toHaveTextContent('pom.xml');
    });
  });
});

describe('EditorWorkspace model and request cleanup', () => {
  it('disposes a closed active tab only after the editor path has switched', async () => {
    const user = userEvent.setup();
    const pathWhenDispose = new Map<string, string>();
    vi.spyOn(projectMonacoModels, 'disposeProjectModels');
    vi.spyOn(projectMonacoModels, 'disposeProjectModel').mockImplementation((_projectId, path) => {
      pathWhenDispose.set(
        path,
        screen.queryByTestId('mock-editor')?.getAttribute('data-path') ?? '',
      );
    });
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    openFile(APP);
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    await user.click(screen.getByRole('tab', { name: /pom.xml/ }));
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, POM).toString(),
      );
    });

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));

    await waitFor(() => {
      expect(projectMonacoModels.disposeProjectModel).toHaveBeenCalledWith(
        ALICE_SEED_PROJECT_ID,
        POM,
      );
    });
    expect(pathWhenDispose.get(POM)).toBe(
      toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
    );
    expect(projectMonacoModels.disposeProjectModels).not.toHaveBeenCalled();
  });

  it('keeps monaco models across tab switches and disposes only on close', async () => {
    const user = userEvent.setup();
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    const { release } = delayThenPassthrough(
      '/api/v1/projects/:projectId/files/content',
      'src/main/java/demo/App.java',
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    await waitFor(() => {
      expect(monaco.editor.getModel(pomUri)).not.toBeNull();
    });
    expect(recordedEditor.last?.keepCurrentModel).toBe(true);

    openFile(APP);
    expect(await screen.findByRole('status', { name: 'Loading file content' })).toBeInTheDocument();
    expect(document.querySelector('.monaco-editor')).toBeNull();
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();

    release();
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();

    openFile(LARGE_NOTES);
    await screen.findByRole('textbox');
    expect(document.querySelector('.monaco-editor')).toBeNull();
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();

    await user.click(screen.getByRole('tab', { name: /pom.xml/ }));
    await screen.findByTestId('mock-editor');
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();

    openFile(LOGO);
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(document.querySelector('.monaco-editor')).toBeNull();
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();

    await user.click(screen.getByRole('tab', { name: /pom.xml/ }));
    await screen.findByTestId('mock-editor');
    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    await waitFor(() => {
      expect(monaco.editor.getModel(pomUri)).toBeNull();
    });
  });

  it('does not duplicate tabs or content requests on a duplicate click while fresh', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    openFile(POM);
    openFile(POM);

    expect(screen.getAllByRole('tab', { name: /pom.xml/ })).toHaveLength(1);
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
  });

  it('disposes the previous project models when the project id changes', async () => {
    vi.spyOn(projectMonacoModels, 'disposeProjectModels');
    await authenticateAsAlice();
    const { rerender } = renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');

    workspaceSessionStore.getState().activateProject(BOB_SEED_PROJECT_ID);
    rerender(
      <AppProviders>
        <EditorWorkspace projectId={BOB_SEED_PROJECT_ID} writesLocked={false} />
      </AppProviders>,
    );

    expect(projectMonacoModels.disposeProjectModels).toHaveBeenCalledWith(ALICE_SEED_PROJECT_ID);
  });

  it('does not let a stale old-project response activate a tab in the new project', async () => {
    const { release } = delayThenPassthrough(
      '/api/v1/projects/:projectId/files/meta',
      'pom.xml',
    );
    await authenticateAsAlice();
    const { rerender } = renderWorkspace();
    openFile(POM);
    expect(await screen.findByRole('status', { name: 'Loading file metadata' })).toBeInTheDocument();

    workspaceSessionStore.getState().activateProject(BOB_SEED_PROJECT_ID);
    rerender(
      <AppProviders>
        <EditorWorkspace projectId={BOB_SEED_PROJECT_ID} writesLocked={false} />
      </AppProviders>,
    );
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceSessionStore.getState().activePath).toBeNull();
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
    expect(getFileRequestCount('meta', BOB_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
  });

  it('registers disposeAllProjectModels and unregisters on unmount', () => {
    const unregister = vi.fn();
    const register = vi
      .spyOn(workspaceResourceRegistry, 'register')
      .mockReturnValue(unregister);
    const { unmount } = render(
      <AppProviders>
        <EditorWorkspace projectId={ALICE_SEED_PROJECT_ID} writesLocked={false} />
      </AppProviders>,
    );

    expect(register).toHaveBeenCalledWith(projectMonacoModels.disposeAllProjectModels);
    unmount();
    expect(unregister).toHaveBeenCalled();
  });
});

describe('EditorWorkspace download', () => {
  it('disables Download only while the blob request is in flight', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/download', async ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'assets/logo.png') {
          return undefined;
        }
        await gate;
        return undefined;
      }),
    );
    ensureObjectUrlFns();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/logo');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LOGO);
    const download = await screen.findByRole('button', { name: 'Download' });

    await user.click(download);
    expect(download).toBeDisabled();
    release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
    });
    expect(getFileRequestCount('download', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(1);
  });

  it('shows an inline retryable download error without leaving the blocked view', async () => {
    const user = userEvent.setup();
    let failDownload = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/download', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'assets/logo.png') {
          return undefined;
        }
        if (failDownload) {
          failDownload = false;
          recordFileRequest('download', ALICE_SEED_PROJECT_ID, 'assets/logo.png');
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock download failure', traceId: 'trace-dl' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    ensureObjectUrlFns();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/logo');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LOGO);

    await user.click(await screen.findByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to download/i);
    expect(screen.getAllByText('logo.png').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(getFileRequestCount('download', ALICE_SEED_PROJECT_ID, 'assets/logo.png')).toBe(2);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('EditorTabs Stage 2 contract', () => {
  it('keeps the reusable tab contract without a save dot when isDirty is false', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    const tab = await screen.findByRole('tab', { name: /pom.xml/ });
    expect(tab).not.toHaveTextContent('*');
    expect(tab).toHaveAttribute('title', 'pom.xml');
  });
});

function delayPut(matchPath: string): { release: () => void; puts: () => number } {
  let release = () => {};
  let puts = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.put('/api/v1/projects/:projectId/files/content', async ({ request }) => {
      if (new URL(request.url).searchParams.get('path') === matchPath) {
        puts += 1;
        await gate;
      }
      return undefined;
    }),
  );
  return { release, puts: () => puts };
}

describe('EditorWorkspace writable buffers', () => {
  it('registers a monaco buffer once, dirties the tab on edit, and binds CtrlCmd+S', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');

    const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    const first = workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM);
    expect(first?.kind).toBe('monaco');
    expect(first?.isDirty()).toBe(false);
    expect(monaco.editor.getModel(uri)).not.toBeNull();
    expect(recordedEditor.saveKeybinding).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project edited />');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    });
    expect(first?.isDirty()).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBe(first);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    openFile(APP);
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    openFile(POM);
    await screen.findByTestId('mock-editor');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBe(first);
    expect(monaco.editor.getModel(uri)?.getValue()).toBe('<project edited />');
    expect(recordedEditor.last?.onChange).toBeUndefined();
    expect(recordedEditor.last?.value).toBeUndefined();
  });

  it('edits large Markdown through an epoch buffer and remounts from the snapshot', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LARGE_NOTES);
    const textarea = await screen.findByRole('textbox');
    const original = (textarea as HTMLTextAreaElement).value;
    const next = `${original} appended notes`;

    fireEvent.change(textarea, { target: { value: next } });

    const buffer = workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES);
    expect(buffer?.kind).toBe('plain-text');
    expect(buffer?.isDirty()).toBe(true);
    expect(buffer?.snapshot().content).toBe(next);
    expect(JSON.stringify(workspaceSessionStore.getState())).not.toContain('appended notes');
    expect(await screen.findByRole('tab', { name: /large-notes.md/ })).toHaveTextContent('*');

    openFile(POM);
    await screen.findByTestId('mock-editor');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    openFile(LARGE_NOTES);
    const remounted = await screen.findByRole('textbox');
    expect(remounted).toHaveValue(next);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)).toBe(buffer);
  });

  it('never registers a buffer for BLOCKED files and hides Save', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LOGO);
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LOGO)).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('EditorWorkspace save lifecycle', () => {
  it('saves the captured snapshot, shows status, and stays dirty after a later edit', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project saved />');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pom.xml/ })).not.toHaveTextContent('*');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(false);

    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project later />');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    });
    expect(screen.queryByRole('status', { name: 'Saved' })).not.toBeInTheDocument();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
  });

  it('retries the failed path and hides leftover feedback when the active file changes', async () => {
    const user = userEvent.setup();
    const putPaths: string[] = [];
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        putPaths.push(path);
        if (path === 'pom.xml' && putPaths.filter((item) => item === 'pom.xml').length === 1) {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock save failure', traceId: 'trace-save' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project failed />');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to save file/i);

    openFile(APP);
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    editMonacoModel(ALICE_SEED_PROJECT_ID, APP, 'class App { /* dirty */ }');
    await waitFor(() => expect(screen.getByRole('tab', { name: /App.java/ })).toHaveTextContent('*'));

    openFile(POM);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(putPaths).toEqual(['pom.xml', 'pom.xml']));
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, APP)?.isDirty()).toBe(true);
  });

  it('clears Saved when the active path changes', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project saved />');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();

    openFile(APP);
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Saved' })).not.toBeInTheDocument();
    });
  });

  it('disables a duplicate project save while the write is pending', async () => {
    const user = userEvent.setup();
    const { release, puts } = delayPut('pom.xml');
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project pending />');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Saving' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    recordedEditor.saveHandler?.();
    expect(puts()).toBe(1);

    release();
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();
    expect(puts()).toBe(1);
  });

  it('keeps the dirty buffer and shows a retryable alert on save failure', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Mock save failure', traceId: 'trace-save' },
          { status: 500 },
        );
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project failed />');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to save file/i);
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      '<project failed />',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('saves from the monaco CtrlCmd+S handler and the plain-text keydown', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project shortcut />');
    await waitFor(() => expect(recordedEditor.saveHandler).not.toBeNull());

    recordedEditor.saveHandler?.();
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();

    openFile(LARGE_NOTES);
    const textarea = await screen.findByRole('textbox');
    fireEvent.change(textarea, { target: { value: '# Large notes\n\nshortcut save\n' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.keyDown(textarea, { key: 's', ctrlKey: true });
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();
    expect(
      workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.isDirty(),
    ).toBe(false);
  });
});

describe('EditorWorkspace renderer mode transitions', () => {
  it('switches renderer from the submitted snapshot only after a successful save', async () => {
    const user = userEvent.setup();
    const submitted = '# Alice Notebook\n\nnow plain\n';
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'README.md') {
          return undefined;
        }
        return HttpResponse.json({
          file: {
            path: 'README.md',
            name: 'README.md',
            sizeBytes: 20 * 1024 * 1024 + 1,
            mediaType: 'text/markdown',
            encoding: 'UTF-8',
            language: 'markdown',
            renderMode: 'PLAIN_TEXT',
            blockReason: null,
          },
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(README);
    await screen.findByTestId('mock-editor');
    const monacoUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, README);
    editMonacoModel(ALICE_SEED_PROJECT_ID, README, submitted);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const textarea = await screen.findByRole('textbox');
    expect(textarea).toHaveValue(submitted);
    expect(document.querySelector('.monaco-editor')).toBeNull();
    expect(monaco.editor.getModel(monacoUri)).toBeNull();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)?.kind).toBe('plain-text');
    expect(workspaceSessionStore.getState().activePath).toBe(README);
    expect(workspaceSessionStore.getState().openPaths).toEqual([README]);
    expect(screen.getByRole('tab', { name: /README.md/ })).not.toHaveTextContent('*');
  });

  it('keeps leftover README and large-notes isolated when switching two PLAIN_TEXT tabs', async () => {
    const user = userEvent.setup();
    const leftover = '# leftover-readme-unique\n';
    const leftoverDirty = '# leftover-readme-unique\nunsaved\n';
    const notesEdit = '# large-notes-unique\n';
    const notesLater = '# large-notes-unique\nmore notes\n';
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'README.md') {
          return undefined;
        }
        return HttpResponse.json({
          file: {
            path: 'README.md',
            name: 'README.md',
            sizeBytes: 20 * 1024 * 1024 + 1,
            mediaType: 'text/markdown',
            encoding: 'UTF-8',
            language: 'markdown',
            renderMode: 'PLAIN_TEXT',
            blockReason: null,
          },
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(README);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, README, leftover);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const readmeBox = await screen.findByRole('textbox', { name: 'README.md' });
    expect(readmeBox).toHaveValue(leftover);
    fireEvent.change(readmeBox, { target: { value: leftoverDirty } });
    await waitFor(() => expect(screen.getByRole('tab', { name: /README.md/ })).toHaveTextContent('*'));

    openFile(LARGE_NOTES);
    const notesBox = await screen.findByRole('textbox', { name: 'large-notes.md' });
    fireEvent.change(notesBox, { target: { value: notesEdit } });
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.snapshot().content).toBe(
      notesEdit,
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)?.snapshot().content).toBe(
      leftoverDirty,
    );

    openFile(README);
    expect(await screen.findByRole('textbox', { name: 'README.md' })).toHaveValue(leftoverDirty);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.snapshot().content).toBe(
      notesEdit,
    );

    openFile(LARGE_NOTES);
    const remountedNotes = await screen.findByRole('textbox', { name: 'large-notes.md' });
    expect(remountedNotes).toHaveValue(notesEdit);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)?.snapshot().content).toBe(
      leftoverDirty,
    );
    fireEvent.change(remountedNotes, { target: { value: notesLater } });
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.snapshot().content).toBe(
      notesLater,
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)?.snapshot().content).toBe(
      leftoverDirty,
    );

    openFile(README);
    expect(await screen.findByRole('textbox', { name: 'README.md' })).toHaveValue(leftoverDirty);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.snapshot().content).toBe(
      notesLater,
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README)?.path).toBe(README);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.path).toBe(LARGE_NOTES);
  });

  it('keeps later in-flight edits dirty after a successful renderer mode change', async () => {
    const user = userEvent.setup();
    const submitted = '# Alice Notebook\n\nnow plain\n';
    const later = '# Alice Notebook\n\nnow plain\nlater\n';
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', async ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'README.md') {
          return undefined;
        }
        await gate;
        return HttpResponse.json({
          file: {
            path: 'README.md',
            name: 'README.md',
            sizeBytes: 20 * 1024 * 1024 + 1,
            mediaType: 'text/markdown',
            encoding: 'UTF-8',
            language: 'markdown',
            renderMode: 'PLAIN_TEXT',
            blockReason: null,
          },
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(README);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, README, submitted);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Saving' })).toBeInTheDocument();
    editMonacoModel(ALICE_SEED_PROJECT_ID, README, later);
    release();

    const textarea = await screen.findByRole('textbox');
    expect(textarea).toHaveValue(later);
    const buffer = workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, README);
    expect(buffer?.kind).toBe('plain-text');
    expect(buffer?.snapshot().content).toBe(later);
    expect(buffer?.isDirty()).toBe(true);
    expect(screen.getByRole('tab', { name: /README.md/ })).toHaveTextContent('*');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('does not switch renderer or discard content when an over-limit save is rejected', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        return HttpResponse.json(
          { code: 'FILE_TOO_LARGE', message: 'File is too large', traceId: 'trace-413' },
          { status: 413 },
        );
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    const kept = '<project too large />';
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, kept);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/file is too large/i);
    expect(screen.getByTestId('mock-editor')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.kind).toBe('monaco');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(kept);
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
  });
});

describe('EditorWorkspace unsaved tab close', () => {
  it('closes a clean tab immediately without a dialog and disposes the model after switch', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceSessionStore.getState().activePath).toBeNull();
    expect(authSession.getSnapshot().status).toBe('authenticated');
    await waitFor(() => {
      expect(monaco.editor.getModel(pomUri)).toBeNull();
    });
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
  });

  it('Cancel on a dirty tab has zero side effects on tab, model and buffer', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project dirty />');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    });
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceSessionStore.getState().activePath).toBe(POM);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      '<project dirty />',
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(monaco.editor.getModel(pomUri)?.getValue()).toBe('<project dirty />');
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Discard closes only the captured dirty tab and drops that buffer', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project dirty />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));
    openFile(APP);
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    const appUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, APP);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    await user.click(await screen.findByRole('button', { name: DISCARD_LABEL }));

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([APP]);
    expect(workspaceSessionStore.getState().activePath).toBe(APP);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, APP)).toBeDefined();
    await waitFor(() => {
      expect(monaco.editor.getModel(pomUri)).toBeNull();
    });
    expect(monaco.editor.getModel(appUri)).not.toBeNull();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Save and close uses the captured path after a later tab switch', async () => {
    const user = userEvent.setup();
    const putPaths: string[] = [];
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', ({ request }) => {
        putPaths.push(new URL(request.url).searchParams.get('path') ?? '');
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project saved-close />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));
    openFile(APP);
    await waitFor(() => {
      expect(screen.getByTestId('mock-editor')).toHaveAttribute(
        'data-path',
        toProjectModelUri(ALICE_SEED_PROJECT_ID, APP).toString(),
      );
    });
    editMonacoModel(ALICE_SEED_PROJECT_ID, APP, 'class App { /* dirty */ }');
    await waitFor(() => expect(screen.getByRole('tab', { name: /App.java/ })).toHaveTextContent('*'));

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /App.java/ }));
    await user.click(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL }));

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    });
    expect(putPaths).toEqual(['pom.xml']);
    expect(workspaceSessionStore.getState().openPaths).toEqual([APP]);
    expect(workspaceSessionStore.getState().activePath).toBe(APP);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, APP)?.isDirty()).toBe(true);
    expect(screen.getByRole('tab', { name: /App.java/ })).toHaveTextContent('*');
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Save and close failure keeps the dialog, tab, model and dirty buffer', async () => {
    const user = userEvent.setup();
    server.use(
      http.put('/api/v1/projects/:projectId/files/content', () => {
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Mock save failure', traceId: 'trace-save-close' },
          { status: 500 },
        );
      }),
    );
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project failed-close />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    await user.click(await screen.findByRole('button', { name: SAVE_AND_CLOSE_LABEL }));

    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toHaveTextContent(
      /unable to save file/i,
    );
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      '<project failed-close />',
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(monaco.editor.getModel(pomUri)?.getValue()).toBe('<project failed-close />');
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Save and close success with a later edit keeps the dialog and dirty captured buffer', async () => {
    const user = userEvent.setup();
    const { release } = delayPut('pom.xml');
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project first />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    await user.click(await screen.findByRole('button', { name: SAVE_AND_CLOSE_LABEL }));
    expect(await screen.findByRole('status', { name: 'Saving' })).toBeInTheDocument();
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project later-close />');
    release();

    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toHaveTextContent(
      REMAINING_CHANGES_MESSAGE,
    );
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      '<project later-close />',
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(monaco.editor.getModel(pomUri)?.getValue()).toBe('<project later-close />');
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Cancel during Save-and-close does not close the tab after a later success', async () => {
    const user = userEvent.setup();
    const { release } = delayPut('pom.xml');
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project cancel-close />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    await user.click(await screen.findByRole('button', { name: SAVE_AND_CLOSE_LABEL }));
    expect(await screen.findByRole('status', { name: 'Saving' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    release();

    await waitFor(() => {
      expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(false);
    });
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceSessionStore.getState().activePath).toBe(POM);
    expect(monaco.editor.getModel(pomUri)).not.toBeNull();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });

  it('Save and close after a skipped save closes when the captured buffer is already clean', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project then-clean />');
    await waitFor(() => expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*'));

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Saved' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pom.xml/ })).not.toHaveTextContent('*');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(false);

    await user.click(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL }));

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(authSession.getSnapshot().status).toBe('authenticated');
  });
});

describe('EditorWorkspace run lock', () => {
  it('sets Monaco readOnly/domReadOnly, keeps buffer text, and disables Save when writesLocked', async () => {
    await authenticateAsAlice();
    const { rerender } = renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    const original = monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))?.getValue();
    expect(original).toBeTruthy();
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project locked />');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    rerender(
      <AppProviders>
        <EditorWorkspace projectId={ALICE_SEED_PROJECT_ID} writesLocked />
      </AppProviders>,
    );

    expect(recordedEditor.last?.options).toEqual({
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))?.getValue()).toBe(
      '<project locked />',
    );
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);

    recordedEditor.saveHandler?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('status', { name: 'Saved' })).not.toBeInTheDocument();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
  });

  it('marks the plain-text textarea readOnly and ignores edits when writesLocked', async () => {
    await authenticateAsAlice();
    renderWorkspace(ALICE_SEED_PROJECT_ID, true);
    openFile(LARGE_NOTES);

    const textarea = await screen.findByRole('textbox');
    const original = (textarea as HTMLTextAreaElement).value;
    expect(textarea).toHaveAttribute('readonly');
    expect(original.length).toBeGreaterThan(0);
    fireEvent.change(textarea, { target: { value: `${original} locked-edit` } });
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.isDirty()).toBe(false);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, LARGE_NOTES)?.snapshot().content).toBe(
      original,
    );
    expect(JSON.stringify(workspaceSessionStore.getState())).not.toContain('locked-edit');
  });

  it('disables dirty-close Save while Discard and Cancel stay available', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const { rerender } = renderWorkspace();
    openFile(POM);
    await screen.findByTestId('mock-editor');
    editMonacoModel(ALICE_SEED_PROJECT_ID, POM, '<project dirty-close />');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    });

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL })).toBeEnabled();

    rerender(
      <AppProviders>
        <EditorWorkspace projectId={ALICE_SEED_PROJECT_ID} writesLocked />
      </AppProviders>,
    );

    expect(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL })).toBeDisabled();
    expect(screen.getByRole('button', { name: DISCARD_LABEL })).toBeEnabled();
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
  });

  it('keeps tab selection and blocked download available when writesLocked', async () => {
    const user = userEvent.setup();
    ensureObjectUrlFns();
    await authenticateAsAlice();
    renderWorkspace(ALICE_SEED_PROJECT_ID, true);
    openFile(POM);
    openFile(LOGO);
    expect(await screen.findByRole('button', { name: 'Download' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /pom.xml/ }));
    expect(workspaceSessionStore.getState().activePath).toBe(POM);
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
