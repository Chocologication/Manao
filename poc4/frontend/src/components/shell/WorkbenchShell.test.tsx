import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import * as monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { getFileContent } from '../../api/fileApi';
import { createProject, getProject } from '../../api/projectApi';
import { AppProviders } from '../../app/AppProviders';
import { ApiRequestError } from '../../api/ApiRequestError';
import {
  authSession,
  queryClient,
  workspaceBufferRegistry,
  workspaceResourceRegistry,
} from '../../app/appRuntime';
import type { ProjectSummary } from '../../contracts/project';
import {
  CANCEL_LABEL,
  DISCARD_AND_LEAVE_LABEL,
  SAVE_AND_CLOSE_LABEL,
} from '../../features/editor/unsavedChangesGuard';
import { useWorkspaceSession, workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import * as projectMonacoModels from '../../lib/projectMonacoModels';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID, getFileRequestCount, setWriteScenario } from '../../mocks/state';
import { renderApp, resetAppRuntime } from '../../test/renderApp';
import { WorkbenchShell } from './WorkbenchShell';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');

const ALICE_PROJECT: ProjectSummary = {
  id: ALICE_SEED_PROJECT_ID,
  name: 'Alice Notebook',
  state: 'READY',
  createdAt: '2026-08-21T00:00:00.000Z',
  failureReason: null,
};

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

function renderShell(project: ProjectSummary = ALICE_PROJECT) {
  workspaceSessionStore.getState().activateProject(project.id);
  return render(
    <AppProviders>
      <MemoryRouter>
        <WorkbenchShell project={project} />
      </MemoryRouter>
    </AppProviders>,
  );
}

async function loadedRoot(): Promise<void> {
  expect(await screen.findByRole('treeitem', { name: 'pom.xml' })).toBeInTheDocument();
}

function queryKeyOf(call: unknown): unknown {
  if (typeof call !== 'object' || call === null || !('queryKey' in call)) {
    return undefined;
  }
  return call.queryKey;
}

const HONEST_LOCK_LEAK =
  /run id|runId|run-id|run state|successful reload|silently reload|started a run/i;

function requestUrl(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return '';
}

function runsFetchCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => /\/runs(?:\?|\/|$)/.test(requestUrl(call[0]))).length;
}

const originalClipboardItem = globalThis.ClipboardItem;

beforeEach(() => {
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

describe('WorkbenchShell layout', () => {
  it('renders a 48px top bar with back, name, READY and logout', async () => {
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const header = screen.getByRole('banner');
    expect(header).toHaveClass('h-12');
    expect(within(header).getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(within(header).getByRole('heading', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(within(header).getByText('READY')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  it('renders a 256px sidebar with the project-relative root, refresh and collapse-all', async () => {
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const sidebar = screen.getByRole('complementary', { name: 'Project files' });
    expect(sidebar).toHaveClass('w-[256px]');
    expect(within(sidebar).getByText('/')).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('button', { name: 'Collapse all folders' })).toBeInTheDocument();
  });

  it('keeps File active and shows disabled Run and Terminal without fake panels', async () => {
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const panels = screen.getByRole('tablist', { name: 'Workbench panels' });
    expect(within(panels).getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
    const run = within(panels).getByRole('tab', { name: 'Run' });
    const terminal = within(panels).getByRole('tab', { name: 'Terminal' });
    expect(run).toBeDisabled();
    expect(terminal).toBeDisabled();
    expect(run).toHaveAccessibleDescription(/STAGE_4_UNAVAILABLE/);
    expect(terminal).toHaveAccessibleDescription(/STAGE_4_UNAVAILABLE/);
    expect(screen.queryByTestId('terminal-spike-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-spike-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/mock file tree/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it('does not create document-level horizontal overflow at 1280px', async () => {
    await authenticateAsAlice();
    const { container } = renderShell();
    await loadedRoot();

    const shell = container.querySelector('.workbench-shell');
    expect(shell).not.toBeNull();
    expect(shell).toHaveClass('overflow-hidden');
    expect(screen.getByRole('complementary', { name: 'Project files' })).toHaveClass('w-[256px]');
    expect(screen.getByLabelText('Editor')).toHaveClass('min-w-0');

    document.documentElement.style.width = '1280px';
    document.body.style.width = '1280px';
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(1280);
  });
});

describe('WorkbenchShell skip link', () => {
  it('is visually hidden until focused, precedes the tree, and focuses the editor without changing selection', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().selectedPath).toBe('pom.xml');

    const skip = screen.getByRole('link', { name: 'Skip to editor' });
    const tree = screen.getByRole('tree', { name: 'Files' });
    const panels = screen.getByRole('tablist', { name: 'Workbench panels' });
    expect(skip).toHaveClass('skip-to-editor');
    expect(skip.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(skip.compareDocumentPosition(panels) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    await user.click(skip);
    expect(screen.getByLabelText('Editor')).toHaveFocus();
    expect(workspaceSessionStore.getState().selectedPath).toBe('pom.xml');
  });
});

describe('WorkbenchShell tree and editor', () => {
  it('toggles a directory without opening it and opens a file into the editor', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /src/ })).not.toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toHaveAttribute('aria-selected', 'true');
    expect(getFileRequestCount('meta', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBeGreaterThan(0);
  });

  it('selecting a tab updates tree selection', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    await user.click(screen.getByRole('treeitem', { name: 'README.md' }));
    expect(await screen.findByRole('tab', { name: /README.md/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'README.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.click(screen.getByRole('tab', { name: /pom.xml/ }));
    expect(screen.getByRole('treeitem', { name: 'pom.xml' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: 'README.md' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(workspaceSessionStore.getState().selectedPath).toBe('pom.xml');
  });

  it('closing the last tab leaves a quiet empty editor surface', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));

    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Editor')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /welcome/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/get started/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open a file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no file selected/i)).not.toBeInTheDocument();
  });

  it('does not register disposeAllProjectModels on the shell itself', async () => {
    const register = vi.spyOn(workspaceResourceRegistry, 'register');
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    expect(register).toHaveBeenCalledWith(projectMonacoModels.disposeAllProjectModels);
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe('WorkbenchPage project transitions', () => {
  it('cancels, disposes and removes the old project before activating a different one', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const created = await createProject({ name: 'Second Lab' });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');

    const cancelQueries = vi.spyOn(queryClient, 'cancelQueries');
    const removeQueries = vi.spyOn(queryClient, 'removeQueries');
    const disposeModels = vi.spyOn(projectMonacoModels, 'disposeProjectModels');
    const disposeBuffers = vi.spyOn(workspaceBufferRegistry, 'disposeProject');

    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeDefined();
    });
    const resetSession = vi.spyOn(useWorkspaceSession.getState(), 'reset');

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    const card = await screen.findByRole('article', { name: 'Second Lab' });
    await user.click(within(card).getByRole('link', { name: /open/i }));

    await waitFor(() => {
      expect(workspaceSessionStore.getState().projectId).toBe(created.id);
    });
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceSessionStore.getState().selectedPath).toBeNull();
    expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();

    const cancelCall = cancelQueries.mock.calls.findIndex(
      (call) => JSON.stringify(queryKeyOf(call[0])) === JSON.stringify(fileKeys.all(ALICE_SEED_PROJECT_ID)),
    );
    const removeCall = removeQueries.mock.calls.findIndex(
      (call) => JSON.stringify(queryKeyOf(call[0])) === JSON.stringify(fileKeys.all(ALICE_SEED_PROJECT_ID)),
    );
    const disposeCall = disposeModels.mock.calls.findIndex((call) => call[0] === ALICE_SEED_PROJECT_ID);
    const disposeBufferCall = disposeBuffers.mock.calls.findIndex((call) => call[0] === ALICE_SEED_PROJECT_ID);
    expect(cancelCall).toBeGreaterThanOrEqual(0);
    expect(removeCall).toBeGreaterThanOrEqual(0);
    expect(disposeCall).toBeGreaterThanOrEqual(0);
    expect(disposeBufferCall).toBeGreaterThanOrEqual(0);
    expect(resetSession).toHaveBeenCalled();
    const cancelOrder = cancelQueries.mock.invocationCallOrder[cancelCall]!;
    const disposeBufferOrder = disposeBuffers.mock.invocationCallOrder[disposeBufferCall]!;
    const disposeModelOrder = disposeModels.mock.invocationCallOrder[disposeCall]!;
    const resetOrder = resetSession.mock.invocationCallOrder[0]!;
    const removeOrder = removeQueries.mock.invocationCallOrder[removeCall]!;
    expect(cancelOrder).toBeLessThan(disposeBufferOrder);
    expect(cancelOrder).toBeLessThan(disposeModelOrder);
    expect(disposeBufferOrder).toBeLessThan(resetOrder);
    expect(disposeModelOrder).toBeLessThan(resetOrder);
    expect(resetOrder).toBeLessThan(removeOrder);
  }, 15_000);

  it('does not wipe a same-project session that is already re-activated after unmount', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const first = renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    const openPaths = workspaceSessionStore.getState().openPaths;

    first.unmount();
    expect(workspaceSessionStore.getState().projectId).toBe(ALICE_SEED_PROJECT_ID);
    expect(workspaceSessionStore.getState().openPaths).toEqual(openPaths);

    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().projectId).toBe(ALICE_SEED_PROJECT_ID);
    expect(workspaceSessionStore.getState().openPaths).toEqual(openPaths);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeDefined();
  }, 15_000);
});

async function dirtyPomFromWorkbench(
  user: ReturnType<typeof userEvent.setup> = userEvent.setup(),
): Promise<void> {
  expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
  await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
  expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
  const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
  await waitFor(() => {
    expect(monaco.editor.getModel(uri)).not.toBeNull();
  });
  const model = monaco.editor.getModel(uri)!;
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: '<project dirty-nav />' }], () => null);
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
  });
}

async function expireCurrentSessionToken(): Promise<void> {
  const token = authSession.getAccessToken();
  expect(token).toBeTruthy();
  const expire = await fetch('/api/v1/session/expire', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(expire.status).toBe(204);
}

describe('WorkbenchShell unsaved leave and logout', () => {
  it('Cancel on Back to projects keeps route, auth, tab, model and dirty buffer', async () => {
    const user = userEvent.setup();
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem');
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save all/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveAttribute(
      'data-pathname',
      `/projects/${ALICE_SEED_PROJECT_ID}`,
    );
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      '<project dirty-nav />',
    );
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))?.getValue()).toBe(
      '<project dirty-nav />',
    );
    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  }, 15_000);

  it('Discard and leave on Back to projects leaves the workbench and discards dirty buffers', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    await user.click(await screen.findByRole('button', { name: DISCARD_AND_LEAVE_LABEL }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveAttribute('data-pathname', '/projects');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(false);
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
  }, 15_000);

  it('Cancel on browser history keeps the dirty workbench', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const view = renderApp({
      initialEntries: ['/projects', `/projects/${ALICE_SEED_PROJECT_ID}`],
      initialIndex: 1,
    });
    await dirtyPomFromWorkbench(user);

    await view.router.navigate(-1);
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

    expect(screen.getByTestId('location-echo')).toHaveAttribute(
      'data-pathname',
      `/projects/${ALICE_SEED_PROJECT_ID}`,
    );
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))).not.toBeNull();
  }, 15_000);

  it('Discard and leave on browser history proceeds to projects', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const view = renderApp({
      initialEntries: ['/projects', `/projects/${ALICE_SEED_PROJECT_ID}`],
      initialIndex: 1,
    });
    await dirtyPomFromWorkbench(user);

    await view.router.navigate(-1);
    await user.click(await screen.findByRole('button', { name: DISCARD_AND_LEAVE_LABEL }));

    await waitFor(() => {
      expect(screen.getByTestId('location-echo')).toHaveAttribute('data-pathname', '/projects');
    });
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
  }, 15_000);

  it('Cancel on logout leaves auth, route, tab, model and buffer intact', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: CANCEL_LABEL }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveAttribute(
      'data-pathname',
      `/projects/${ALICE_SEED_PROJECT_ID}`,
    );
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(authSession.getAccessToken()).not.toBeNull();
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))).not.toBeNull();
  }, 15_000);

  it('Discard and leave on logout clears auth and workspace without a leftover dialog', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await user.click(await screen.findByRole('button', { name: DISCARD_AND_LEAVE_LABEL }));

    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveAttribute('data-pathname', '/login');
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'logout' });
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(monaco.editor.getModel(pomUri)).toBeNull();
  }, 15_000);

  it('current-token 401 does not show a cancellable dirty dialog', async () => {
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench();
    const pomUri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);

    await expireCurrentSessionToken();
    const error = await getFileContent(ALICE_SEED_PROJECT_ID, POM).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });

    await waitFor(() => {
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CANCEL_LABEL })).not.toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveAttribute('data-pathname', '/login');
    expect(authSession.getSnapshot()).toEqual({ status: 'anonymous', reason: 'unauthorized' });
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)).toBeUndefined();
    expect(monaco.editor.getModel(pomUri)).toBeNull();
  }, 15_000);

  it('registers one beforeunload listener only while a dirty buffer exists', async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(add.mock.calls.filter((call) => call[0] === 'beforeunload')).toHaveLength(0);

    await dirtyPomFromWorkbench(user);
    const installed = add.mock.calls.filter((call) => call[0] === 'beforeunload');
    expect(installed).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await user.click(await screen.findByRole('button', { name: DISCARD_AND_LEAVE_LABEL }));
    await waitFor(() => {
      const removed = remove.mock.calls.filter((call) => call[0] === 'beforeunload');
      expect(removed).toHaveLength(1);
      expect(removed[0]?.[1]).toBe(installed[0]?.[1]);
    });
    expect(add.mock.calls.filter((call) => call[0] === 'beforeunload')).toHaveLength(1);
  }, 15_000);

  it('does not stack a leave dialog on top of an open dirty-tab confirm', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    await user.click(screen.getByRole('button', { name: 'Close pom.xml' }));
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));

    expect(screen.getAllByRole('dialog', { name: 'Unsaved changes' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: SAVE_AND_CLOSE_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DISCARD_AND_LEAVE_LABEL })).not.toBeInTheDocument();
    expect(screen.getByTestId('location-echo')).toHaveAttribute(
      'data-pathname',
      `/projects/${ALICE_SEED_PROJECT_ID}`,
    );
    expect(authSession.getSnapshot().status).toBe('authenticated');
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
  }, 15_000);
});

describe('WorkbenchShell run preconditions', () => {
  it('describes DIRTY_FILES on Run and Terminal while a buffer is dirty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    const run = screen.getByRole('tab', { name: 'Run' });
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(run).toBeDisabled();
    expect(terminal).toBeDisabled();
    expect(run).toHaveAccessibleDescription(/DIRTY_FILES/);
    expect(terminal).toHaveAccessibleDescription(/DIRTY_FILES/);
    expect(run).not.toHaveAccessibleDescription(/STAGE_4_UNAVAILABLE/);
    expect(runsFetchCount(fetchSpy)).toBe(0);
  }, 15_000);

  it('describes WRITE_PENDING on Run while a create is in flight and files are clean', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
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
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAccessibleDescription(/STAGE_4_UNAVAILABLE/);

    await user.click(screen.getByRole('button', { name: 'New file' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'pending.md');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Run' })).toHaveAccessibleDescription(/WRITE_PENDING/);
    });
    expect(screen.getByRole('tab', { name: 'Run' })).toBeDisabled();
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
    expect(runsFetchCount(fetchSpy)).toBe(0);
    release();
  }, 15_000);

  it('describes REVISION_UNAVAILABLE on Run until the root tree revision arrives', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path');
        if (path === '') {
          await held;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tab', { name: 'Run' })).toHaveAccessibleDescription(
      /REVISION_UNAVAILABLE/,
    );
    expect(runsFetchCount(fetchSpy)).toBe(0);

    release();
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAccessibleDescription(/STAGE_4_UNAVAILABLE/);
    expect(runsFetchCount(fetchSpy)).toBe(0);
  }, 15_000);
});

describe('WorkbenchShell lock and conflict honesty', () => {
  it('keeps dirty content and does not claim a Run ID when save is PROJECT_LOCKED', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    setWriteScenario('locked');
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);
    const contentBefore = workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content;
    const contentCount = getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/project is locked/i);
    expect(alert).not.toHaveTextContent(HONEST_LOCK_LEAK);
    expect(document.body.textContent ?? '').not.toMatch(HONEST_LOCK_LEAK);
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      contentBefore,
    );
    expect(monaco.editor.getModel(toProjectModelUri(ALICE_SEED_PROJECT_ID, POM))?.getValue()).toBe(
      contentBefore,
    );
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(contentCount);
    expect(runsFetchCount(fetchSpy)).toBe(0);
  }, 15_000);

  it('keeps dirty content and does not claim a successful reload on revision conflict', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    setWriteScenario('conflict');
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);
    const contentBefore = workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content;
    const contentCount = getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/workspace revision conflict/i);
    expect(alert).not.toHaveTextContent(HONEST_LOCK_LEAK);
    expect(document.body.textContent ?? '').not.toMatch(HONEST_LOCK_LEAK);
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toHaveTextContent('*');
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.snapshot().content).toBe(
      contentBefore,
    );
    expect(getFileRequestCount('content', ALICE_SEED_PROJECT_ID, 'pom.xml')).toBe(contentCount);
    expect(runsFetchCount(fetchSpy)).toBe(0);
  }, 15_000);
});

describe('WorkbenchPage lazy route and shell boundary', () => {
  it('keeps the workbench behind a dynamic import and production entry free of Monaco', () => {
    const route = readFileSync('src/features/projects/ProjectRoutePage.tsx', 'utf8');
    expect(route).toMatch(/lazy\(\(\) => import\(['"]\.\/WorkbenchPage['"]\)\)/);
    expect(route).not.toMatch(/from ['"]\.\/WorkbenchPage['"]/);
    expect(route).not.toMatch(/ReadonlyWorkbenchPage/);
    expect(route).not.toMatch(/from ['"]monaco-editor['"]/);
    expect(route).not.toMatch(/from ['"]@monaco-editor\/react['"]/);

    for (const file of ['src/main.tsx', 'src/app/AppRouter.tsx', 'src/app/appRuntime.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"]monaco-editor['"]/);
      expect(source, file).not.toMatch(/from ['"]monaco-editor\//);
      expect(source, file).not.toMatch(/from ['"]@monaco-editor\/react['"]/);
    }
  });

  it('does not put physical identifiers or /runs into the shell', () => {
    const source = readFileSync('src/components/shell/WorkbenchShell.tsx', 'utf8');
    expect(source).not.toMatch(/pvcName|podName|jobName|namespace|serviceAccount/);
    expect(source).not.toMatch(/\/runs/);
    expect(source).not.toMatch(/\/api\/v1\/session\/write-scenario/);
    expect(source).not.toMatch(/from ['"]@\/spike\//);
    expect(source).not.toMatch(/from ['"]@\/terminal\//);
  });
});
