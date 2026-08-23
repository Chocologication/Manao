import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import type { FileContentResponse, FileTreeResponse } from '../../contracts/file';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../../features/files/pathPolicy';
import { server } from '../../mocks/node';
import {
  ALICE_SEED_PROJECT_ID,
  BOB_SEED_PROJECT_ID,
  getFileRequestCount,
  recordFileRequest,
  setWriteScenario,
} from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { FileTree } from './FileTree';

const ALICE = { username: 'alice', password: 'demo-pass' };
const SRC = parseProjectRelativePath('src');
const POM = parseProjectRelativePath('pom.xml');
const NOTES = parseProjectRelativePath('notes.md');
const APP_JAVA = parseProjectRelativePath('src/main/java/demo/App.java');
const ROOT = parseProjectDirectoryPath('');

const TREE_FAILURE = {
  code: 'INTERNAL_ERROR' as const,
  message: 'Mock tree failure',
  traceId: 'trace-tree',
};

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function renderTree(projectId = ALICE_SEED_PROJECT_ID) {
  workspaceSessionStore.getState().activateProject(projectId);
  return render(
    <AppProviders>
      <FileTree projectId={projectId} />
    </AppProviders>,
  );
}

async function loadedRoot(): Promise<void> {
  expect(await screen.findByRole('treeitem', { name: 'src' })).toBeInTheDocument();
}

function groupAfter(treeitem: HTMLElement): HTMLElement {
  const group = treeitem.nextElementSibling;
  expect(group).toHaveAttribute('role', 'group');
  return group as HTMLElement;
}

function captureCreateBodies(): Array<{ kind: string; path: string }> {
  const bodies: Array<{ kind: string; path: string }> = [];
  server.use(
    http.post('/api/v1/projects/:projectId/entries', async ({ request }) => {
      const body = (await request.clone().json()) as { kind: string; path: string };
      bodies.push({ kind: body.kind, path: body.path });
      return undefined;
    }),
  );
  return bodies;
}

async function submitBasename(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  const input = await screen.findByLabelText('Name');
  await user.clear(input);
  if (name !== '') {
    await user.type(input, name);
  }
  await user.keyboard('{Enter}');
}

function rootNames(): string[] {
  return screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label') ?? '');
}

function revision(): unknown {
  return queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID));
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('FileTree lazy requests', () => {
  it('mounts with only the root listing request', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(1);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(0);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs')).toBe(0);
  });

  it('does not request children while src is collapsed', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(0);
  });

  it('requests src exactly once when expanded', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(1);
  });

  it('reuses the fresh src cache on collapse and re-expand', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    const src = screen.getByRole('treeitem', { name: 'src' });
    await user.click(src);
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    await user.click(src);
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();
    });
    await user.click(src);
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(1);
  });
});

describe('FileTree scoped states', () => {
  it('keeps root rows visible while a child directory is loading', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        if (new URL(request.url).searchParams.get('path') === 'src') {
          recordFileRequest('tree', ALICE_SEED_PROJECT_ID, 'src');
          await gate;
          return HttpResponse.json({
            directory: 'src',
            entries: [
              {
                path: 'src/main',
                name: 'main',
                kind: 'directory',
                hidden: false,
                sizeBytes: null,
                hasChildren: true,
              },
            ],
            workspaceRevision: 'mock-rev-0001',
          });
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const src = screen.getByRole('treeitem', { name: 'src' });
    expect(within(src).getByTestId('spinner')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'docs' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();

    release();
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
  });

  it('shows an empty directory message on that node only', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') === 'src') {
          recordFileRequest('tree', ALICE_SEED_PROJECT_ID, 'src');
          return HttpResponse.json({
            directory: 'src',
            entries: [],
            workspaceRevision: 'mock-rev-0001',
          });
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const src = await screen.findByRole('treeitem', { name: 'src' });
    expect(within(groupAfter(src)).getByText(/^empty$/i)).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toBeInTheDocument();
    expect(screen.queryByText(/no files/i)).not.toBeInTheDocument();
  });

  it('scopes a directory error and retry to that node', async () => {
    const user = userEvent.setup();
    let failSrc = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'src') {
          return undefined;
        }
        recordFileRequest('tree', ALICE_SEED_PROJECT_ID, 'src');
        if (failSrc) {
          return HttpResponse.json(TREE_FAILURE, { status: 500 });
        }
        return HttpResponse.json({
          directory: 'src',
          entries: [
            {
              path: 'src/main',
              name: 'main',
              kind: 'directory',
              hidden: false,
              sizeBytes: null,
              hasChildren: true,
            },
          ],
          workspaceRevision: 'mock-rev-0001',
        });
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    const rootCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '');

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const src = await screen.findByRole('treeitem', { name: 'src' });
    const srcGroup = groupAfter(src);
    expect(within(srcGroup).getByRole('alert')).toHaveTextContent(/unable to load directory/i);
    expect(screen.getByRole('treeitem', { name: 'docs' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();

    failSrc = false;
    await user.click(within(srcGroup).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(2);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, '')).toBe(rootCount);
  });

  it('does not render a misleading empty workspace on root error', async () => {
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', () =>
        HttpResponse.json(TREE_FAILURE, { status: 500 }),
      ),
    );
    await authenticateAsAlice();
    renderTree();

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load files/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
    expect(screen.queryByText(/no files/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^empty$/i)).not.toBeInTheDocument();
  });

  it('shows hidden .gitignore at the project root', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    expect(screen.getByRole('treeitem', { name: '.gitignore' })).toBeInTheDocument();
  });

  it('renders a sorted copy and does not mutate the query cache array', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    const names = screen.getAllByRole('treeitem').map((item) => item.getAttribute('aria-label'));
    expect(names).toEqual(['assets', 'docs', 'src', '.gitignore', 'pom.xml', 'README.md']);

    const cached = queryClient.getQueryData<FileTreeResponse>(
      fileKeys.tree(ALICE_SEED_PROJECT_ID, ROOT),
    );
    expect(cached?.entries.map((entry) => entry.name)).toEqual([
      '.gitignore',
      'README.md',
      'pom.xml',
      'assets',
      'docs',
      'src',
    ]);
  });
});

describe('FileTree selection and commands', () => {
  it('selects and opens a file without fetching metadata or content', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    const session = workspaceSessionStore.getState();
    expect(session.selectedPath).toBe(POM);
    expect(session.openPaths).toEqual([POM]);
    expect(session.activePath).toBe(POM);
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toHaveAttribute('aria-selected', 'true');
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(0);
  });

  it('toggles a directory without opening it', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const session = workspaceSessionStore.getState();
    expect(session.expandedPaths.has(SRC)).toBe(true);
    expect(session.selectedPath).toBe(SRC);
    expect(session.openPaths).toEqual([]);
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-selected', 'true');
  });

  it('cancels then invalidates file queries on refresh without clearing open tabs', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);

    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({ queryKey: fileKeys.trees(ALICE_SEED_PROJECT_ID) });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: fileKeys.trees(ALICE_SEED_PROJECT_ID) });
    });
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(invalidate.mock.invocationCallOrder[0]);
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceSessionStore.getState().activePath).toBe(POM);
  });

  it('collapse-all only clears Zustand expanded paths and keeps the query cache', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(
      queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath('src'))),
    ).toBeDefined();

    const remove = vi.spyOn(queryClient, 'removeQueries');
    await user.click(screen.getByRole('button', { name: 'Collapse all folders' }));

    await waitFor(() => {
      expect(workspaceSessionStore.getState().expandedPaths.size).toBe(0);
    });
    expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(fileKeys.tree(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath('src'))),
    ).toBeDefined();
  });
});

const OWNER_OR_PHYSICAL_LEAK = /bob|prj-bob|usr-bob|lab-notes|C:\\|D:\\|\/Users\/|\/etc\/|\/home\/|\/var\//;

describe('FileTree authorization and invalid payloads', () => {
  it('shows generic access denied for another owner tree without a partial tree or path leak', async () => {
    await authenticateAsAlice();
    renderTree(BOB_SEED_PROJECT_ID);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/access denied/i);
    expect(alert).not.toHaveTextContent(OWNER_OR_PHYSICAL_LEAK);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
    expect(screen.queryByText(/no files/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^empty$/i)).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(OWNER_OR_PHYSICAL_LEAK);
  });

  it('stops the affected directory and offers retry when the tree payload is invalid, without a partial tree', async () => {
    const user = userEvent.setup();
    let invalidSrc = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'src') {
          return undefined;
        }
        recordFileRequest('tree', ALICE_SEED_PROJECT_ID, 'src');
        if (invalidSrc) {
          return HttpResponse.json({
            directory: 'src',
            entries: [
              {
                path: 'src/main',
                name: 'main',
                kind: 'directory',
                hidden: false,
                sizeBytes: null,
                hasChildren: true,
              },
              {
                path: 'C:\\Users\\alice\\secret',
                name: 'secret',
                kind: 'file',
                hidden: false,
                sizeBytes: 1,
                hasChildren: null,
              },
            ],
          });
        }
        return HttpResponse.json({
          directory: 'src',
          entries: [
            {
              path: 'src/main',
              name: 'main',
              kind: 'directory',
              hidden: false,
              sizeBytes: null,
              hasChildren: true,
            },
          ],
          workspaceRevision: 'mock-rev-0001',
        });
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const src = await screen.findByRole('treeitem', { name: 'src' });
    const srcGroup = groupAfter(src);
    expect(within(srcGroup).getByRole('alert')).toHaveTextContent(/unable to load directory/i);
    expect(within(srcGroup).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'docs' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/C:\\|\/Users\/|\/etc\//);

    invalidSrc = false;
    await user.click(within(srcGroup).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(2);
  });
});

describe('FileTree retry isolation', () => {
  it('does not refetch a successful sibling directory when retrying a failed one', async () => {
    const user = userEvent.setup();
    let failSrc = true;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') !== 'src') {
          return undefined;
        }
        recordFileRequest('tree', ALICE_SEED_PROJECT_ID, 'src');
        if (failSrc) {
          return HttpResponse.json(TREE_FAILURE, { status: 500 });
        }
        return HttpResponse.json({
          directory: 'src',
          entries: [
            {
              path: 'src/main',
              name: 'main',
              kind: 'directory',
              hidden: false,
              sizeBytes: null,
              hasChildren: true,
            },
          ],
          workspaceRevision: 'mock-rev-0001',
        });
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'docs' }));
    expect(await screen.findByRole('treeitem', { name: 'large-notes.md' })).toBeInTheDocument();
    const docsCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs');
    expect(docsCount).toBe(1);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'assets')).toBe(0);

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const src = await screen.findByRole('treeitem', { name: 'src' });
    const srcGroup = groupAfter(src);
    expect(within(srcGroup).getByRole('alert')).toHaveTextContent(/unable to load directory/i);

    failSrc = false;
    await user.click(within(srcGroup).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(2);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs')).toBe(docsCount);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'assets')).toBe(0);
    expect(screen.getByRole('treeitem', { name: 'large-notes.md' })).toBeInTheDocument();
  });
});

describe('FileTree accessibility', () => {
  it('exposes tree semantics, tooltips, and 32px icon hit boxes', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    expect(screen.getByRole('tree')).toBeInTheDocument();
    const src = screen.getByRole('treeitem', { name: 'src' });
    expect(src).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toHaveAttribute('aria-selected', 'false');

    const refresh = screen.getByRole('button', { name: 'Refresh' });
    const collapse = screen.getByRole('button', { name: 'Collapse all folders' });
    const newFile = screen.getByRole('button', { name: 'New file' });
    const newFolder = screen.getByRole('button', { name: 'New folder' });
    expect(refresh).toHaveAttribute('title', 'Refresh');
    expect(collapse).toHaveAttribute('title', 'Collapse all folders');
    expect(newFile).toHaveAttribute('title', 'New file');
    expect(newFolder).toHaveAttribute('title', 'New folder');
    for (const button of [refresh, collapse, newFile, newFolder]) {
      expect(button.className).toMatch(/\bh-8\b/);
      expect(button.className).toMatch(/\bw-8\b/);
      expect(button.className).not.toMatch(/scale-/);
    }
  });

  it('supports Enter, arrows, and parent focus on visible nodes', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    const src = screen.getByRole('treeitem', { name: 'src' });
    src.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(src).toHaveAttribute('aria-expanded', 'true');
    expect(workspaceSessionStore.getState().selectedPath).toBe(SRC);

    src.focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: 'main' })).not.toBeInTheDocument();
    });
    expect(src).toHaveAttribute('aria-expanded', 'false');

    src.focus();
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();

    const main = screen.getByRole('treeitem', { name: 'main' });
    main.focus();
    await user.keyboard('{ArrowLeft}');
    expect(src).toHaveFocus();

    const pom = screen.getByRole('treeitem', { name: 'pom.xml' });
    pom.focus();
    await user.keyboard('{Enter}');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceSessionStore.getState().selectedPath).toBe(POM);

    const items = screen.getAllByRole('treeitem');
    const srcIndex = items.indexOf(src);
    items[srcIndex].focus();
    await user.keyboard('{ArrowDown}');
    expect(items[srcIndex + 1]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(items[srcIndex]).toHaveFocus();
  });

  it('puts the focus ring on the focused directory treeitem itself', async () => {
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    const src = screen.getByRole('treeitem', { name: 'src' });
    src.focus();
    expect(src).toHaveFocus();
    expect(src.className).toMatch(/focus-visible:ring-2/);
    expect(src.querySelector('[class*="focus-visible:ring-2"]')).toBeNull();
  });

  it('keeps a visible treeitem tabbable after collapse-all from a nested file', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'main' }));
    expect(await screen.findByRole('treeitem', { name: 'java' })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'java' }));
    expect(await screen.findByRole('treeitem', { name: 'demo' })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'demo' }));
    expect(await screen.findByRole('treeitem', { name: 'App.java' })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'App.java' }));
    expect(workspaceSessionStore.getState().selectedPath).toBe(
      parseProjectRelativePath('src/main/java/demo/App.java'),
    );

    await user.click(screen.getByRole('button', { name: 'Collapse all folders' }));
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: 'App.java' })).not.toBeInTheDocument();
    });

    const visible = screen.getAllByRole('treeitem');
    expect(visible.length).toBeGreaterThan(1);
    const tabbable = visible.find((item) => item.tabIndex === 0);
    expect(tabbable).toBeDefined();
    expect(visible.filter((item) => item.tabIndex === 0)).toHaveLength(1);

    tabbable!.focus();
    const index = visible.indexOf(tabbable!);
    await user.keyboard('{ArrowDown}');
    expect(visible[index + 1] ?? visible[index]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(tabbable).toHaveFocus();
  });
});

async function ensureExpanded(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<void> {
  const item = screen.getByRole('treeitem', { name });
  if (item.getAttribute('aria-expanded') !== 'true') {
    await user.click(item);
  }
}

async function expandToAppJava(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await ensureExpanded(user, 'src');
  expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
  await ensureExpanded(user, 'main');
  expect(await screen.findByRole('treeitem', { name: 'java' })).toBeInTheDocument();
  await ensureExpanded(user, 'java');
  expect(await screen.findByRole('treeitem', { name: 'demo' })).toBeInTheDocument();
  await ensureExpanded(user, 'demo');
  expect(await screen.findByRole('treeitem', { name: 'App.java' })).toBeInTheDocument();
}

describe('FileTree create commands', () => {
  it('creates a file at root when nothing is selected and opens the new tab', async () => {
    const user = userEvent.setup();
    const bodies = captureCreateBodies();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    expect(workspaceSessionStore.getState().selectedPath).toBeNull();
    const srcCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src');
    const docsCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs');

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'notes.md');

    expect(await screen.findByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
    expect(bodies).toEqual([{ kind: 'file', path: 'notes.md' }]);
    const session = workspaceSessionStore.getState();
    expect(session.selectedPath).toBe(NOTES);
    expect(session.openPaths).toEqual([NOTES]);
    expect(session.activePath).toBe(NOTES);
    expect(queryClient.getQueryData<FileContentResponse>(fileKeys.content(ALICE_SEED_PROJECT_ID, NOTES))).toEqual(
      {
        path: NOTES,
        content: '',
        workspaceRevision: revision(),
      },
    );
    expect(queryClient.getQueryData(fileKeys.meta(ALICE_SEED_PROJECT_ID, NOTES))).toMatchObject({
      path: NOTES,
    });
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'notes.md')).toBe(0);
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'notes.md')).toBe(0);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(srcCount);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs')).toBe(docsCount);
  });

  it('creates inside a selected directory and inside the parent of a selected file', async () => {
    const user = userEvent.setup();
    const bodies = captureCreateBodies();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await submitBasename(user, 'lib');

    expect(await screen.findByRole('treeitem', { name: 'lib' })).toBeInTheDocument();
    expect(bodies).toEqual([{ kind: 'directory', path: 'src/lib' }]);
    expect(workspaceSessionStore.getState().selectedPath).toBe(parseProjectRelativePath('src/lib'));
    expect(workspaceSessionStore.getState().expandedPaths.has(parseProjectRelativePath('src/lib'))).toBe(
      true,
    );
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);

    await expandToAppJava(user);
    await user.click(screen.getByRole('treeitem', { name: 'App.java' }));
    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'extra.java');

    expect(await screen.findByRole('treeitem', { name: 'extra.java' })).toBeInTheDocument();
    expect(bodies.at(-1)).toEqual({ kind: 'file', path: 'src/main/java/demo/extra.java' });
    expect(workspaceSessionStore.getState().selectedPath).toBe(
      parseProjectRelativePath('src/main/java/demo/extra.java'),
    );
    expect(workspaceSessionStore.getState().openPaths).toContain(
      parseProjectRelativePath('src/main/java/demo/extra.java'),
    );
  });

  it('expands collapsed ancestors of a created nested file', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await expandToAppJava(user);
    await user.click(screen.getByRole('treeitem', { name: 'App.java' }));
    expect(workspaceSessionStore.getState().selectedPath).toBe(APP_JAVA);

    await user.click(screen.getByRole('button', { name: 'Collapse all folders' }));
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: 'App.java' })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'extra.java');

    expect(await screen.findByRole('treeitem', { name: 'extra.java' })).toBeInTheDocument();
    const expanded = workspaceSessionStore.getState().expandedPaths;
    expect(expanded.has(SRC)).toBe(true);
    expect(expanded.has(parseProjectRelativePath('src/main'))).toBe(true);
    expect(expanded.has(parseProjectRelativePath('src/main/java'))).toBe(true);
    expect(expanded.has(parseProjectRelativePath('src/main/java/demo'))).toBe(true);
  });

  it('selects and expands a created directory without requesting unrelated trees', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    const srcCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src');
    const docsCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs');
    const assetsCount = getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'assets');

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await submitBasename(user, 'tmp');

    const tmp = parseProjectRelativePath('tmp');
    expect(await screen.findByRole('treeitem', { name: 'tmp' })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().selectedPath).toBe(tmp);
    expect(workspaceSessionStore.getState().expandedPaths.has(tmp)).toBe(true);
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    await waitFor(() => {
      expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'tmp')).toBe(1);
    });
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'src')).toBe(srcCount);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'docs')).toBe(docsCount);
    expect(getFileRequestCount('tree', ALICE_SEED_PROJECT_ID, 'assets')).toBe(assetsCount);
    expect(within(groupAfter(screen.getByRole('treeitem', { name: 'tmp' }))).getByText(/^empty$/i)).toBeInTheDocument();
  });

  it('does not send a create request for an invalid basename', async () => {
    const user = userEvent.setup();
    const bodies = captureCreateBodies();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'src/bad.java');

    expect(bodies).toHaveLength(0);
    expect(screen.getByRole('alert')).toHaveTextContent('Entry name required');
    expect(screen.getByRole('dialog', { name: 'New file' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('src/bad.java');
  });

  it('preserves dialog input, selection and revision on collision without mutating the tree', async () => {
    const user = userEvent.setup();
    const bodies = captureCreateBodies();
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    const namesBefore = rootNames();
    const rev = revision();

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'pom.xml');

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(screen.getByLabelText('Name')).toHaveValue('pom.xml');
    expect(screen.getByRole('dialog', { name: 'New file' })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().selectedPath).toBe(POM);
    expect(revision()).toBe(rev);
    expect(rootNames()).toEqual(namesBefore);
    expect(bodies).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bodies).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(screen.getByRole('dialog', { name: 'New file' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('pom.xml');
    expect(revision()).toBe(rev);
    expect(rootNames()).toEqual(namesBefore);
  });

  it('preserves dialog input, selection and revision when the project is locked', async () => {
    const user = userEvent.setup();
    setWriteScenario('locked');
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    const namesBefore = rootNames();
    const rev = revision();

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await submitBasename(user, 'locked-dir');

    expect(await screen.findByRole('alert')).toHaveTextContent(/project is locked/i);
    expect(screen.getByLabelText('Name')).toHaveValue('locked-dir');
    expect(workspaceSessionStore.getState().selectedPath).toBe(SRC);
    expect(revision()).toBe(rev);
    expect(rootNames()).toEqual(namesBefore);
    expect(screen.queryByRole('treeitem', { name: 'locked-dir' })).not.toBeInTheDocument();
  });

  it('preserves dialog input, selection and revision on workspace revision conflict', async () => {
    const user = userEvent.setup();
    setWriteScenario('conflict');
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    const namesBefore = rootNames();
    const rev = revision();

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'conflicted.md');

    expect(await screen.findByRole('alert')).toHaveTextContent(/workspace revision conflict/i);
    expect(screen.getByLabelText('Name')).toHaveValue('conflicted.md');
    expect(workspaceSessionStore.getState().selectedPath).toBe(POM);
    expect(revision()).toBe(rev);
    expect(rootNames()).toEqual(namesBefore);
    expect(screen.queryByRole('treeitem', { name: 'conflicted.md' })).not.toBeInTheDocument();
  });

  it('keeps 32px create buttons while a create is pending', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/projects/:projectId/entries', async () => {
        await held;
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderTree();
    await loadedRoot();

    await user.click(screen.getByRole('button', { name: 'New file' }));
    await submitBasename(user, 'notes.md');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    const newFile = screen.getByRole('button', { name: 'New file' });
    const newFolder = screen.getByRole('button', { name: 'New folder' });
    expect(newFile.className).toMatch(/\bh-8\b/);
    expect(newFile.className).toMatch(/\bw-8\b/);
    expect(newFolder.className).toMatch(/\bh-8\b/);
    expect(newFolder.className).toMatch(/\bw-8\b/);
    expect(newFolder).toBeDisabled();
    expect(screen.getByRole('dialog', { name: 'New file' })).toBeInTheDocument();

    release();
    expect(await screen.findByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
  });
});
