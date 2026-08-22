import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceResourceRegistry } from '../../app/appRuntime';
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
import { resetAppRuntime } from '../../test/renderApp';
import { ReadonlyEditorWorkspace } from './ReadonlyEditorWorkspace';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');
const APP = parseProjectRelativePath('src/main/java/demo/App.java');
const LARGE_NOTES = parseProjectRelativePath('docs/large-notes.md');
const TOO_LARGE = parseProjectRelativePath('docs/too-large.md');
const LOGO = parseProjectRelativePath('assets/logo.png');
const LATIN1 = parseProjectRelativePath('docs/latin1.txt');

type RecordedEditorProps = {
  path?: string;
  value?: string;
  language?: string;
  keepCurrentModel?: boolean;
  options?: {
    readOnly?: boolean;
    domReadOnly?: boolean;
    automaticLayout?: boolean;
    scrollBeyondLastLine?: boolean;
  };
  onChange?: unknown;
};

const recordedEditor = vi.hoisted(() => ({
  last: null as RecordedEditorProps | null,
}));

vi.mock('@monaco-editor/react', () => {
  function MockEditor(props: RecordedEditorProps) {
    recordedEditor.last = {
      path: props.path,
      value: props.value,
      language: props.language,
      keepCurrentModel: props.keepCurrentModel,
      options: props.options,
      onChange: props.onChange,
    };
    useEffect(() => {
      const modelPath = props.path;
      if (modelPath === undefined || modelPath === '') {
        return undefined;
      }
      const uri = monaco.Uri.parse(modelPath);
      if (monaco.editor.getModel(uri) === null) {
        monaco.editor.createModel(props.value ?? '', props.language, uri);
      }
      return () => {
        if (props.keepCurrentModel !== true) {
          monaco.editor.getModel(uri)?.dispose();
        }
      };
    }, [props.path, props.value, props.language, props.keepCurrentModel]);
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

function renderWorkspace(projectId = ALICE_SEED_PROJECT_ID) {
  workspaceSessionStore.getState().activateProject(projectId);
  return render(
    <AppProviders>
      <ReadonlyEditorWorkspace projectId={projectId} />
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

beforeEach(() => {
  recordedEditor.last = null;
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

describe('ReadonlyEditorWorkspace metadata-gated views', () => {
  it('loads MONACO_TEXT as read-only Monaco after exactly one metadata and one content request', async () => {
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
    expect(recordedEditor.last?.options).toEqual({
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
    });
    expect(recordedEditor.last?.onChange).toBeUndefined();
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(1);
  });

  it('loads PLAIN_TEXT as a read-only textarea and never mounts Monaco', async () => {
    await authenticateAsAlice();
    renderWorkspace();
    openFile(LARGE_NOTES);

    const textarea = await screen.findByRole('textbox');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('readonly');
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

describe('ReadonlyEditorWorkspace scoped loading and errors', () => {
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

describe('ReadonlyEditorWorkspace authorization and path errors', () => {
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

describe('ReadonlyEditorWorkspace retry isolation', () => {
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

describe('ReadonlyEditorWorkspace tabs', () => {
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

describe('ReadonlyEditorWorkspace model and request cleanup', () => {
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
        <ReadonlyEditorWorkspace projectId={BOB_SEED_PROJECT_ID} />
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
        <ReadonlyEditorWorkspace projectId={BOB_SEED_PROJECT_ID} />
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
        <ReadonlyEditorWorkspace projectId={ALICE_SEED_PROJECT_ID} />
      </AppProviders>,
    );

    expect(register).toHaveBeenCalledWith(projectMonacoModels.disposeAllProjectModels);
    unmount();
    expect(unregister).toHaveBeenCalled();
  });
});

describe('ReadonlyEditorWorkspace download', () => {
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
