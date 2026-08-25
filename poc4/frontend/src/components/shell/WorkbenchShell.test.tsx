import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as monaco from 'monaco-editor';
import { readFileSync } from 'node:fs';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { createEntry, getFileContent, listDirectory, saveFileContent } from '../../api/fileApi';
import { createProject, getProject } from '../../api/projectApi';
import { startRun } from '../../api/runApi';
import { AppProviders } from '../../app/AppProviders';
import { ApiRequestError } from '../../api/ApiRequestError';
import {
  authSession,
  connectionRegistry,
  queryClient,
  workspaceBufferRegistry,
  workspaceResourceRegistry,
} from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import type { ProjectSummary } from '../../contracts/project';
import { runPreconditionDescription } from '../../features/editor/runPreconditions';
import {
  CANCEL_LABEL,
  DISCARD_AND_LEAVE_LABEL,
  SAVE_AND_CLOSE_LABEL,
} from '../../features/editor/unsavedChangesGuard';
import { useWorkspaceSession, workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../../features/files/pathPolicy';
import { WorkbenchPage } from '../../features/projects/WorkbenchPage';
import { RunAuthorityCoordinator } from '../../features/runs/RunAuthorityCoordinator';
import { runKeys } from '../../features/runs/runQueries';
import * as projectMonacoModels from '../../lib/projectMonacoModels';
import { disposeAllProjectModels, toProjectModelUri } from '../../lib/projectMonacoModels';
import { server } from '../../mocks/node';
import {
  getActiveRun,
  startRun as mockStartRun,
  setRunScenario,
  transitionRun,
} from '../../mocks/runState';
import { ALICE_SEED_PROJECT_ID, getFileRequestCount, setWriteScenario } from '../../mocks/state';
import { renderApp, resetAppRuntime } from '../../test/renderApp';
import { WorkbenchShell } from './WorkbenchShell';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POM = parseProjectRelativePath('pom.xml');
const README = parseProjectRelativePath('README.md');
const APP_TEST = parseProjectRelativePath('src/test/java/demo/AppTest.java');
const RELOAD_MARKER = 'ensoai-stage4-reload-change';

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

async function waitUntilWritesUnlocked(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'New file' })).toBeEnabled();
  });
}

async function loadedEditable(): Promise<void> {
  await loadedRoot();
  await waitUntilWritesUnlocked();
}

function filePanel(): HTMLElement {
  const panel = document.getElementById('workbench-editor');
  expect(panel).toBeInstanceOf(HTMLElement);
  return panel as HTMLElement;
}

function runPanel(): HTMLElement {
  const panel = document.getElementById('workbench-run-panel');
  expect(panel).toBeInstanceOf(HTMLElement);
  return panel as HTMLElement;
}

function terminalPanel(): HTMLElement {
  const panel = document.getElementById('workbench-terminal-panel');
  expect(panel).toBeInstanceOf(HTMLElement);
  return panel as HTMLElement;
}

function expectPanelInteractive(panel: HTMLElement, interactive: boolean): void {
  if (interactive) {
    expect(panel.getAttribute('aria-hidden')).not.toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.className).not.toMatch(/\binvisible\b/);
    expect(panel.className).not.toMatch(/\bpointer-events-none\b/);
    return;
  }
  expect(panel.getAttribute('aria-hidden')).toBe('true');
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(panel.className).toMatch(/\binvisible\b/);
  expect(panel.className).toMatch(/\bpointer-events-none\b/);
}

async function seedLockingRun(): Promise<void> {
  setRunScenario('disconnect');
  const tree = await listDirectory(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath(''));
  const result = mockStartRun(ALICE_SEED_PROJECT_ID, {
    expectedWorkspaceRevision: tree.workspaceRevision,
  });
  expect(result.ok).toBe(true);
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

function fetchMethod(call: unknown[]): string {
  const init = call[1];
  if (typeof init === 'object' && init !== null && 'method' in init && typeof (init as { method?: unknown }).method === 'string') {
    return (init as { method: string }).method.toUpperCase();
  }
  return 'GET';
}

function fetchPathname(call: unknown[]): string {
  try {
    return new URL(requestUrl(call[0]), 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function runStartPostCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(
    (call) => fetchMethod(call) === 'POST' && /\/runs$/.test(fetchPathname(call)),
  ).length;
}

function runStopPostCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(
    (call) => fetchMethod(call) === 'POST' && /\/runs\/[^/]+\/stop$/.test(fetchPathname(call)),
  ).length;
}

function terminalSessionPostCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(
    (call) => fetchMethod(call) === 'POST' && /\/terminal-sessions$/.test(fetchPathname(call)),
  ).length;
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

  it('keeps Terminal unloaded until first selection and never opens a session automatically', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    const panels = screen.getByRole('tablist', { name: 'Workbench panels' });
    expect(within(panels).getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
    const run = within(panels).getByRole('tab', { name: 'Run' });
    const terminal = within(panels).getByRole('tab', { name: 'Terminal' });
    expect(run).toBeEnabled();
    expect(run).toHaveAttribute('aria-selected', 'false');
    expect(terminal).toBeEnabled();
    expect(terminal).toHaveAttribute('aria-selected', 'false');
    expect(filePanel()).toBeInTheDocument();
    expect(runPanel()).toBeInTheDocument();
    expectPanelInteractive(filePanel(), true);
    expectPanelInteractive(runPanel(), false);
    expect(document.getElementById('workbench-terminal-panel')).toBeNull();
    expect(document.querySelector('.xterm')).toBeNull();
    expect(terminalSessionPostCount(fetchSpy)).toBe(0);

    await user.click(terminal);

    expect(await screen.findByRole('region', { name: 'Job terminal' })).toBeInTheDocument();
    expect(terminal).toHaveAttribute('aria-selected', 'true');
    expectPanelInteractive(terminalPanel(), true);
    expect(document.querySelector('.xterm')).toBeNull();
    expect(terminalSessionPostCount(fetchSpy)).toBe(0);
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

  it('disposes a loaded terminal controller before activating a replacement project', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const created = await createProject({ name: 'Terminal Switch Lab' });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');
    const view = render(
      <AppProviders>
        <MemoryRouter>
          <WorkbenchPage project={ALICE_PROJECT} />
        </MemoryRouter>
      </AppProviders>,
    );
    await loadedEditable();
    await user.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(await screen.findByRole('region', { name: 'Job terminal' })).toBeInTheDocument();
    const { JobTerminalController } = await import('../../features/terminal/JobTerminalController');
    const dispose = vi.spyOn(JobTerminalController.prototype, 'dispose');
    const resetSession = vi.spyOn(useWorkspaceSession.getState(), 'reset');

    view.rerender(
      <AppProviders>
        <MemoryRouter>
          <WorkbenchPage project={ready} />
        </MemoryRouter>
      </AppProviders>,
    );

    await waitFor(() => expect(workspaceSessionStore.getState().projectId).toBe(ready.id));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
      resetSession.mock.invocationCallOrder[0]!,
    );
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
  await waitUntilWritesUnlocked();
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
  it('keeps Terminal independent from dirty Run-start preconditions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    await dirtyPomFromWorkbench(user);

    const run = screen.getByRole('tab', { name: 'Run' });
    const terminal = screen.getByRole('tab', { name: 'Terminal' });
    expect(run).toBeEnabled();
    expect(terminal).toBeEnabled();
    expect(terminal).not.toHaveAccessibleDescription(/DIRTY_FILES/);
    await user.click(run);
    const start = await screen.findByRole('button', { name: 'Start run' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', runPreconditionDescription('DIRTY_FILES'));

    await seedLockingRun();
    await queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await user.click(terminal);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled());
    expect(workspaceBufferRegistry.get(ALICE_SEED_PROJECT_ID, POM)?.isDirty()).toBe(true);
    expect(runStartPostCount(fetchSpy)).toBe(0);
  }, 15_000);

  it('disables Start with WRITE_PENDING while a create is in flight and files are clean', async () => {
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
    await waitUntilWritesUnlocked();

    await user.click(screen.getByRole('button', { name: 'New file' }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'pending.md');
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toHaveAttribute(
        'title',
        runPreconditionDescription('WRITE_PENDING'),
      );
    });
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();
    expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(0);
    expect(runStartPostCount(fetchSpy)).toBe(0);
    release();
  }, 15_000);

  it('disables Start with REVISION_UNAVAILABLE until the root tree revision arrives', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async () => {
        await held;
        return undefined;
      }),
    );
    await authenticateAsAlice();
    queryClient.removeQueries({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tab', { name: 'Run' })).toBeEnabled();
    const start = screen.getByRole('button', { name: 'Start run', hidden: true });
    expect(start).toBeDisabled();
    expect(start.getAttribute('title')).toMatch(/REVISION_UNAVAILABLE|AUTHORITY_LOADING/);
    expect(screen.queryByRole('treeitem', { name: 'pom.xml' })).not.toBeInTheDocument();
    expect(runStartPostCount(fetchSpy)).toBe(0);

    release();
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await waitUntilWritesUnlocked();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    });
    expect(runStartPostCount(fetchSpy)).toBe(0);
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
    expect(runStartPostCount(fetchSpy)).toBe(0);
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
    expect(runStartPostCount(fetchSpy)).toBe(0);
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

  it('keeps the terminal behind a lazy import and shell boundaries free of runtime details', () => {
    const source = readFileSync('src/components/shell/WorkbenchShell.tsx', 'utf8');
    expect(source).not.toMatch(/pvcName|podName|jobName|namespace|serviceAccount/);
    expect(source).not.toMatch(/\/api\/v1\/.*runs/);
    expect(source).not.toMatch(/\/api\/v1\/session\/write-scenario/);
    expect(source).not.toMatch(/from ['"]@\/spike\//);
    expect(source).not.toMatch(/from ['"]@\/terminal\//);
    expect(source).not.toMatch(/from ['"]@\/mocks\//);
    expect(source).toMatch(
      /lazy\(\(\) => import\(['"]@\/components\/terminal\/JobTerminalPanel['"]\)\)/,
    );
    expect(source).not.toMatch(
      /import\s+[^;]+from ['"]@\/components\/terminal\/JobTerminalPanel['"]/,
    );
    expect(source).toMatch(/isWorkspaceEditable/);
    expect(source).toMatch(/useRunAuthorityCoordinator/);
    expect(source).not.toMatch(/phase === ['"]EDITABLE['"]/);
  });

  it('keeps terminal transport and controls independent from Run logs and Run mutations', () => {
    for (const file of [
      'src/components/terminal/JobTerminalPanel.tsx',
      'src/features/terminal/JobTerminalController.ts',
      'src/features/terminal/JobTerminalTransport.ts',
      'src/features/terminal/XtermTerminalAdapter.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/RunLogTransport|RunLogStore|useRunLog|callRunLog/i);
    }
    const controller = readFileSync(
      'src/features/terminal/JobTerminalController.ts',
      'utf8',
    );
    expect(controller).not.toMatch(/startRun|stopRun|completeReload|markReload|unlock/i);
  });

  it('keys the workbench shell by project id so authority remounts on project change', () => {
    const source = readFileSync('src/features/projects/WorkbenchPage.tsx', 'utf8');
    expect(source).toMatch(/<WorkbenchShell key=\{project\.id\} project=\{project\} \/>/);
  });
});

describe('WorkbenchShell panel persistence', () => {
  it('keeps File, Run, and a once-loaded Terminal mounted with one active surface', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();

    const file = filePanel();
    const run = runPanel();
    expect(file.parentElement).toBe(run.parentElement);
    expect(file.className).toMatch(/\babsolute\b/);
    expect(run.className).toMatch(/\babsolute\b/);
    expect(file.className).toMatch(/\binset-0\b/);
    expect(run.className).toMatch(/\binset-0\b/);
    expectPanelInteractive(file, true);
    expectPanelInteractive(run, false);

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'false');
    expectPanelInteractive(filePanel(), false);
    expectPanelInteractive(runPanel(), true);
    expect(await screen.findByRole('button', { name: 'Start run' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();
    expect(document.querySelector('.xterm')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(await screen.findByRole('region', { name: 'Job terminal' })).toBeInTheDocument();
    const terminal = terminalPanel();
    expect(file.parentElement).toBe(terminal.parentElement);
    expect(run.parentElement).toBe(terminal.parentElement);
    expectPanelInteractive(file, false);
    expectPanelInteractive(run, false);
    expectPanelInteractive(terminal, true);

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(terminalPanel()).toBe(terminal);
    expectPanelInteractive(terminal, false);
    expectPanelInteractive(run, true);

    await user.click(screen.getByRole('tab', { name: 'File' }));
    expect(terminalPanel()).toBe(terminal);
    expectPanelInteractive(filePanel(), true);
    expectPanelInteractive(runPanel(), false);
    expectPanelInteractive(terminalPanel(), false);
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(workspaceSessionStore.getState().openPaths).toEqual([POM]);
  }, 15_000);

});

describe('WorkbenchShell authority gate', () => {
  it('locks editors and CRUD until the active query resolves, then unlocks', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', async () => {
        await held;
        return HttpResponse.json({ run: null });
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeInTheDocument();

    release();
    await waitUntilWritesUnlocked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
  }, 15_000);

  it('stays locked on authority error and Retry refetches active', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json(
            { code: 'FORBIDDEN', message: 'Access denied', traceId: 'trace-active-403' },
            { status: 403 },
          );
        }
        return HttpResponse.json({ run: null });
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unable to load run authority/i);
    expect(alert).not.toHaveTextContent('trace-active-403');
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(await screen.findByRole('treeitem', { name: 'main' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry loading run authority' }));
    await waitUntilWritesUnlocked();
    expect(attempts).toBeGreaterThan(1);
    expect(screen.queryByText(/unable to load run authority/i)).not.toBeInTheDocument();
  }, 15_000);

  it('relocks New file and Start after an authority refetch error from idle', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    expect(screen.getByRole('button', { name: 'New file' })).toBeEnabled();

    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Access denied', traceId: 'trace-active-403-after-idle' },
          { status: 403 },
        ),
      ),
    );
    await queryClient.refetchQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });

    expect(await screen.findByRole('alert')).toHaveTextContent(/unable to load run authority/i);
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    const start = await screen.findByRole('button', { name: 'Start run' });
    expect(start).toBeDisabled();
  }, 15_000);
});

describe('WorkbenchShell run lock', () => {
  it('locks every write surface while an active run is observed', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    await seedLockingRun();
    renderShell();
    await loadedRoot();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });

    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    const start = await screen.findByRole('button', { name: 'Start run' });
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('RUN_ACTIVE'));
    });
    expect(start).toBeDisabled();
  }, 15_000);

  it('does not POST Stop on back or logout and still closes client sockets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const closeAll = vi.spyOn(connectionRegistry, 'closeAll');
    const user = userEvent.setup();
    await authenticateAsAlice();
    await seedLockingRun();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(runStopPostCount(fetchSpy)).toBe(0);

    await user.click(within(screen.getByRole('article', { name: 'Alice Notebook' })).getByRole('link', { name: /open/i }));
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });

    closeAll.mockClear();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(runStopPostCount(fetchSpy)).toBe(0);
    expect(closeAll).toHaveBeenCalled();
  }, 15_000);

  it('returns 409 PROJECT_LOCKED for direct PUT/CRUD during an active Run and rejects stale start', async () => {
    await authenticateAsAlice();
    await seedLockingRun();
    renderShell();
    await loadedRoot();
    const tree = await listDirectory(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath(''));

    const saveError = await saveFileContent(ALICE_SEED_PROJECT_ID, POM, {
      content: 'bypass-lock',
      expectedWorkspaceRevision: tree.workspaceRevision,
    }).catch((reason: unknown) => reason);
    expect(saveError).toBeInstanceOf(ApiRequestError);
    expect(saveError).toMatchObject({ status: 409, body: { code: 'PROJECT_LOCKED' } });

    const createError = await createEntry(ALICE_SEED_PROJECT_ID, {
      kind: 'file',
      path: parseProjectRelativePath('bypass-lock.txt'),
      expectedWorkspaceRevision: tree.workspaceRevision,
    }).catch((reason: unknown) => reason);
    expect(createError).toBeInstanceOf(ApiRequestError);
    expect(createError).toMatchObject({ status: 409, body: { code: 'PROJECT_LOCKED' } });

    const startError = await startRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: parseWorkspaceRevision('stale-revision-not-current'),
    }).catch((reason: unknown) => reason);
    expect(startError).toBeInstanceOf(ApiRequestError);
    expect(startError).toMatchObject({ status: 409, body: { code: 'WORKSPACE_REVISION_CONFLICT' } });
  }, 15_000);
});

describe('WorkbenchShell workspace reload', () => {
  async function waitUntilRunning(): Promise<NonNullable<ReturnType<typeof getActiveRun>>> {
    await waitFor(() => {
      expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('RUNNING');
    });
    const run = getActiveRun(ALICE_SEED_PROJECT_ID);
    expect(run).not.toBeNull();
    return run as NonNullable<typeof run>;
  }

  async function lockShellWithActiveRun(): Promise<NonNullable<ReturnType<typeof getActiveRun>>> {
    await seedLockingRun();
    await queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    return waitUntilRunning();
  }

  async function terminalizeRun(
    run: NonNullable<ReturnType<typeof getActiveRun>>,
    scenario?: 'disconnect' | 'reload-change',
  ): Promise<void> {
    if (scenario !== undefined) {
      setRunScenario(scenario);
    }
    const result = transitionRun(ALICE_SEED_PROJECT_ID, run.id, {
      state: 'SUCCEEDED',
      terminationReason: 'BUILD_SUCCEEDED',
      exitCode: 0,
    });
    expect(result.ok).toBe(true);
    await queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
  }

  it('updates terminal authority before reload without forwarding transient active null', async () => {
    const user = userEvent.setup();
    const confirmStarted = deferredHold();
    const confirmHeld = deferredHold();
    const reloadHeld = deferredHold();
    const trace: string[] = [];
    let holdConfirmation = false;
    let traceReload = false;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId', async () => {
        if (!holdConfirmation) return undefined;
        confirmStarted.resolve();
        await confirmHeld.promise;
        return undefined;
      }),
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        if (traceReload && new URL(request.url).searchParams.get('path') === '') {
          trace.push('reload');
          await reloadHeld.promise;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    const run = await lockShellWithActiveRun();
    await user.click(screen.getByRole('tab', { name: 'Terminal' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled());

    const { JobTerminalController } = await import('../../features/terminal/JobTerminalController');
    const originalSetRun = JobTerminalController.prototype.setRun;
    const setRun = vi
      .spyOn(JobTerminalController.prototype, 'setRun')
      .mockImplementation(function (
        this: InstanceType<typeof JobTerminalController>,
        nextRun,
      ) {
        trace.push(`terminal:${nextRun?.state ?? 'null'}`);
        return originalSetRun.call(this, nextRun);
      });
    holdConfirmation = true;
    traceReload = true;
    expect(
      transitionRun(ALICE_SEED_PROJECT_ID, run.id, {
        state: 'SUCCEEDED',
        terminationReason: 'BUILD_SUCCEEDED',
        exitCode: 0,
      }).ok,
    ).toBe(true);
    const refetch = queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await confirmStarted.promise;

    await waitFor(() => expect(setRun).toHaveBeenCalled());
    expect(trace).toEqual(['terminal:SUCCEEDED']);

    confirmHeld.resolve();
    await waitFor(() => expect(trace).toContain('reload'));
    expect(trace).toEqual(['terminal:SUCCEEDED', 'reload']);
    reloadHeld.resolve();
    await refetch;
    const reloadIndex = trace.indexOf('reload');
    expect(trace.slice(0, reloadIndex)).toEqual(['terminal:SUCCEEDED']);
  }, 15_000);

  it('keeps writes locked after a terminal run until workspace reload succeeds', async () => {
    let holdReloads = false;
    const held = deferredHold();
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (holdReloads && path === '') {
          await held.promise;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    act(() => {
      workspaceSessionStore.getState().openFile(README);
      workspaceSessionStore.getState().openFile(APP_TEST);
    });
    expect(await screen.findByRole('tab', { name: /README.md/ })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /AppTest.java/ })).toBeInTheDocument();

    const run = await lockShellWithActiveRun();
    holdReloads = true;
    await terminalizeRun(run);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
      expect(screen.getAllByText('Reloading workspace').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: /README.md/ })).toBeInTheDocument();

    held.resolve();
    await waitUntilWritesUnlocked();
    expect(screen.queryAllByText('Reloading workspace')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: /README.md/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Run state', hidden: true })).not.toHaveTextContent(
        'RUNNING',
      );
    });
    expect(screen.getByRole('status', { name: 'Run state', hidden: true })).toHaveTextContent(
      /SUCCEEDED|Idle/,
    );
  }, 15_000);

  it('retries a failed workspace reload from the Run toolbar', async () => {
    const user = userEvent.setup();
    let failReloads = false;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (failReloads && path === '') {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock reload tree failure', traceId: 'trace-reload' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    const run = await lockShellWithActiveRun();
    failReloads = true;
    await terminalizeRun(run);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(await screen.findByText(/workspace reload failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    failReloads = false;
    await user.click(screen.getByRole('button', { name: 'Retry workspace reload' }));
    await user.click(screen.getByRole('tab', { name: 'File' }));
    await waitUntilWritesUnlocked();
    expect(screen.queryByText(/workspace reload failed/i)).not.toBeInTheDocument();
  }, 15_000);

  it('does not completeReload on back or logout while reload is failed', async () => {
    const complete = vi.spyOn(RunAuthorityCoordinator.prototype, 'completeReload');
    const user = userEvent.setup();
    let failReloads = false;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (failReloads && path === '') {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock reload tree failure', traceId: 'trace-reload-nav' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await waitUntilWritesUnlocked();
    const run = await lockShellWithActiveRun();
    failReloads = true;
    await terminalizeRun(run);
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(await screen.findByRole('button', { name: 'Retry workspace reload' })).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();

    failReloads = false;
    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    expect(await screen.findByRole('article', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();

    await user.click(within(screen.getByRole('article', { name: 'Alice Notebook' })).getByRole('link', { name: /open/i }));
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(complete).not.toHaveBeenCalled();
  }, 15_000);

  it('applies reload-change file add/modify/delete before unlocking', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    act(() => {
      workspaceSessionStore.getState().openFile(README);
      workspaceSessionStore.getState().openFile(APP_TEST);
    });
    expect(await screen.findByRole('tab', { name: /README.md/ })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /AppTest.java/ })).toBeInTheDocument();
    const beforeRevision = queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID));

    const run = await lockShellWithActiveRun();
    await terminalizeRun(run, 'reload-change');
    await waitUntilWritesUnlocked();

    expect(screen.getByRole('tab', { name: /README.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /AppTest.java/ })).not.toBeInTheDocument();
    expect(queryClient.getQueryData(fileKeys.content(ALICE_SEED_PROJECT_ID, README))).toEqual(
      expect.objectContaining({ content: expect.stringContaining(RELOAD_MARKER) }),
    );
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).not.toBe(beforeRevision);
    const docs = await listDirectory(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath('docs'));
    expect(docs.entries.map((entry) => entry.name)).toContain('run-output.md');
    await user.click(screen.getByRole('treeitem', { name: 'docs' }));
    expect(await screen.findByRole('treeitem', { name: 'run-output.md' })).toBeInTheDocument();
  }, 15_000);
});

function deferredHold(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
