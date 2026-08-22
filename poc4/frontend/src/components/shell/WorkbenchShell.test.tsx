import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login } from '../../api/authApi';
import { createProject, getProject } from '../../api/projectApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient, workspaceResourceRegistry } from '../../app/appRuntime';
import type { ProjectSummary } from '../../contracts/project';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import * as projectMonacoModels from '../../lib/projectMonacoModels';
import { ALICE_SEED_PROJECT_ID, getFileRequestCount } from '../../mocks/state';
import { renderApp, resetAppRuntime } from '../../test/renderApp';
import { WorkbenchShell } from './WorkbenchShell';

const ALICE = { username: 'alice', password: 'demo-pass' };

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
    expect(within(panels).getByRole('tab', { name: 'Run' })).toBeDisabled();
    expect(within(panels).getByRole('tab', { name: 'Terminal' })).toBeDisabled();
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

describe('ReadonlyWorkbenchPage project transitions', () => {
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

    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('treeitem', { name: 'pom.xml' }, { timeout: 10_000 })).toBeInTheDocument();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByRole('tab', { name: /pom.xml/ })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Back to projects' }));
    const card = await screen.findByRole('article', { name: 'Second Lab' });
    await user.click(within(card).getByRole('link', { name: /open/i }));

    await waitFor(() => {
      expect(workspaceSessionStore.getState().projectId).toBe(created.id);
    });
    expect(workspaceSessionStore.getState().openPaths).toEqual([]);
    expect(workspaceSessionStore.getState().selectedPath).toBeNull();
    expect(screen.queryByRole('tab', { name: /pom.xml/ })).not.toBeInTheDocument();

    const cancelCall = cancelQueries.mock.calls.findIndex(
      (call) => JSON.stringify(queryKeyOf(call[0])) === JSON.stringify(fileKeys.all(ALICE_SEED_PROJECT_ID)),
    );
    const removeCall = removeQueries.mock.calls.findIndex(
      (call) => JSON.stringify(queryKeyOf(call[0])) === JSON.stringify(fileKeys.all(ALICE_SEED_PROJECT_ID)),
    );
    const disposeCall = disposeModels.mock.calls.findIndex((call) => call[0] === ALICE_SEED_PROJECT_ID);
    expect(cancelCall).toBeGreaterThanOrEqual(0);
    expect(removeCall).toBeGreaterThanOrEqual(0);
    expect(disposeCall).toBeGreaterThanOrEqual(0);
    expect(cancelQueries.mock.invocationCallOrder[cancelCall]!).toBeLessThan(
      disposeModels.mock.invocationCallOrder[disposeCall]!,
    );
    expect(disposeModels.mock.invocationCallOrder[disposeCall]!).toBeLessThan(
      removeQueries.mock.invocationCallOrder[removeCall]!,
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
  }, 15_000);
});
