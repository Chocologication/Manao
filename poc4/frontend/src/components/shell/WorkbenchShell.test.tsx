import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
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
import {
  ALICE_SEED_PROJECT_ID,
  getFileRequestCount,
  mockDependencyRequestFingerprint,
  registerMockDependencyOperation,
  setDependencyScenario,
  setWriteScenario,
} from '../../mocks/state';
import { pythonDependencyStorageKey } from '../../api/pythonDependencyApi';
import { PROJECT_BUSY_READ_MAX_RETRIES } from '../../api/projectBusyRetry';
import { renderApp, resetAppRuntime } from '../../test/renderApp';
import type { AgentTaskSnapshot } from '../../contracts/agentTask';
import { agentTaskKeys } from '../../features/ai/agentTaskQueries';
import { isAgentPanelEnabled, isExperimentalTerminalEnabled, WorkbenchShell } from './WorkbenchShell';

const ALICE = { username: 'alice', password: 'demo-pass' };
it('moves AI history to the right and retains the draft through panel and history visibility changes', async () => {
  const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: query === '(min-width: 1024px)', media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
  try {
  await authenticateAsAlice(); renderShell(); await loadedRoot();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'AI' }));
  const history = await screen.findByRole('complementary', { name: '对话历史' });
  expect(within(history).getByRole('button', { name: '新建会话' })).toBeInTheDocument();
  await user.type(screen.getByLabelText('Task goal'), '保留草稿');
  await user.click(screen.getByRole('button', { name: '切换对话历史' }));
  expect(history).toHaveAttribute('hidden'); expect(history).toHaveAttribute('inert');
  await user.click(screen.getByRole('tab', { name: 'File' }));
  expect(screen.getByRole('button', { name: '切换项目洞察' })).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'AI' }));
  expect(screen.getByLabelText('Task goal')).toHaveValue('保留草稿');
  await user.click(screen.getByRole('button', { name: '切换对话历史' }));
  expect(screen.getByRole('complementary', { name: '对话历史' })).toBe(history);
  } finally { media.mockRestore(); }
});
it('traps narrow history focus and restores keyboard access to the composer on Escape', async () => {
  await authenticateAsAlice(); renderShell(); await loadedRoot();
  const user = userEvent.setup();
  await user.click(screen.getByRole('tab', { name: 'AI' }));
  const toggle = screen.getByRole('button', { name: '切换对话历史' });
  await user.click(toggle);
  const drawer = screen.getByRole('dialog', { name: '对话历史' });
  const buttons = within(drawer).getAllByRole('button');
  await waitFor(() => expect(buttons[0]).toHaveFocus());
  await user.tab({ shift: true }); expect(buttons.at(-1)).toHaveFocus();
  await user.tab(); expect(buttons[0]).toHaveFocus();
  expect(drawer.closest('[inert]')).toBeNull();
  await user.keyboard('{Escape}'); expect(toggle).toHaveFocus();
  expect(drawer).toHaveAttribute('hidden'); expect(drawer).toHaveAttribute('inert');
  screen.getByLabelText('Task goal').focus();
  await user.keyboard('继续输入'); expect(screen.getByLabelText('Task goal')).toHaveValue('继续输入');
});
const POM = parseProjectRelativePath('pom.xml');
const README = parseProjectRelativePath('README.md');
const APP_TEST = parseProjectRelativePath('src/test/java/demo/AppTest.java');
const RELOAD_MARKER = 'ensoai-stage4-reload-change';

it('discovers the original uncertain project task after refresh before unlocking writes', async () => {
  const taskId = '33333333-3333-4333-8333-333333333333';
  const url = `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/agent-tasks`;
  let originalReads = 0;
  server.use(
    http.get(`${url}/current`, () => HttpResponse.json({ code: 'ENTRY_NOT_FOUND', message: 'none', traceId: 'none' }, { status: 404 })),
    http.get(`${url}/${taskId}`, () => { originalReads++; return HttpResponse.json({ taskId, state: 'NEEDS_ATTENTION', workspaceRevision: '0', writesLocked: true, progress: [], changedPaths: [], summary: null, failureCode: null, conversationId: '11111111-1111-4111-8111-111111111111' }); }),
  );
  await authenticateAsAlice();
  sessionStorage.setItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`, JSON.stringify({ taskId, conversationId: '11111111-1111-4111-8111-111111111111' }));
  renderShell(); await loadedRoot();
  await waitFor(() => expect(originalReads).toBeGreaterThan(0));
  expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
});

it('keeps the shell project write lock and original pending task while switching conversations', async () => {
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const base = { headSeq: 0, lastTaskId: null, activeTaskId: null, usage: null, compactRequestId: null, compactState: null, compactFailureCode: null };
  const url = `/api/v1/projects/${ALICE_SEED_PROJECT_ID}`;
  let closes = 0;
  server.use(
    http.get(`${url}/agent-tasks/current`, () => HttpResponse.json({ taskId, state: 'RUNNING', workspaceRevision: '0', writesLocked: true, progress: [], changedPaths: [], summary: null, failureCode: null, conversationId: a })),
    http.post(`${url}/agent-tasks/${taskId}/close`, () => { closes++; return HttpResponse.error(); }),
    http.get(`${url}/conversations`, () => HttpResponse.json({ items: [{ ...base, conversationId: a, title: '会话 A' }, { ...base, conversationId: b, title: '会话 B' }], nextCursor: null })),
    http.get(`${url}/conversations/:id`, ({ params }) => HttpResponse.json({ ...base, conversationId: params.id, title: '会话' })),
    http.get(`${url}/conversations/:id/entries`, () => HttpResponse.json({ items: [], nextBeforeSeq: null, nextBeforeOffset: null })),
  );
  await authenticateAsAlice();
  sessionStorage.setItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`, JSON.stringify({ taskId, conversationId: a }));
  renderShell(); await loadedRoot();
  await userEvent.click(screen.getByRole('tab', { name: 'AI' }));
  await userEvent.click(screen.getByRole('button', { name: '切换对话历史' }));
  await userEvent.click(await screen.findByRole('button', { name: '会话 B' }));
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  expect(JSON.parse(sessionStorage.getItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`)!)).toEqual({ taskId, conversationId: a });
  expect(closes).toBe(0);
});

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
  // The mock resets the project sequence, so created project ids repeat across
  // tests; a leftover stored operation id would leak into the next test.
  sessionStorage.clear();
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

describe('WorkbenchShell experimental surfaces', () => {
  it('keeps Terminal disabled unless explicitly enabled', () => {
    expect(isExperimentalTerminalEnabled(undefined)).toBe(false);
    expect(isExperimentalTerminalEnabled('false')).toBe(false);
    expect(isExperimentalTerminalEnabled('true')).toBe(true);
  });

  it('keeps the AI panel disabled unless explicitly enabled', () => {
    expect(isAgentPanelEnabled(undefined)).toBe(false);
    expect(isAgentPanelEnabled('false')).toBe(false);
    expect(isAgentPanelEnabled('true')).toBe(true);
  });
});

describe('WorkbenchShell layout', () => {
  it('opens the command panel with Ctrl+K and runs the highlighted item with Enter', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    await user.keyboard('{Control>}k{/Control}');
    const search = await screen.findByRole('combobox', { name: '搜索命令或已打开文件' });
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(search.closest('dialog')).not.toHaveAttribute('open'));
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  });

  it('renders the branded header with navigation, name and logout', async () => {
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const header = screen.getByRole('banner');
    expect(header).toHaveClass('lab-workbench-header');
    expect(within(header).getByRole('link', { name: 'Back to projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(within(header).getByRole('heading', { name: 'Alice Notebook' })).toBeInTheDocument();
    expect(within(header).getByText('无未保存修改')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  it('renders the responsive explorer with refresh and collapse-all', async () => {
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();

    const sidebar = screen.getByRole('complementary', { name: 'Project files' });
    expect(sidebar).toHaveClass('lab-file-sidebar');
    expect(within(sidebar).getByText('EXPLORER')).toBeInTheDocument();
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
    expect(screen.getByRole('complementary', { name: 'Project files' })).toHaveClass('lab-file-sidebar');
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
    await screen.findByRole('treeitem', {name:'pending.md'});
    await waitFor(()=>expect(queryClient.isMutating()).toBe(0));
  }, 15_000);

  it('disables Start with REVISION_UNAVAILABLE until the root tree revision arrives', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    let entered=false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async () => {
        entered=true;
        await held;
        return undefined;
      }),
    );
    await authenticateAsAlice();
    queryClient.removeQueries({ queryKey: fileKeys.all(ALICE_SEED_PROJECT_ID) });
    renderApp({ initialEntries: [`/projects/${ALICE_SEED_PROJECT_ID}`] });
    expect(await screen.findByRole('tab', { name: 'Run' })).toBeEnabled();
    await waitFor(()=>expect(entered).toBe(true));
    expect(queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID))).toBeUndefined();
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

  it('revokes the production terminal controller before null-active detail confirmation settles', async () => {
    const user = userEvent.setup();
    const confirmStarted = deferredHold();
    const confirmHeld = deferredHold();
    const reloadHeld = deferredHold();
    const trace: string[] = [];
    let holdConfirmation = false;
    let returnNullActive = false;
    let traceReload = false;
    let confirmedDetail: NonNullable<ReturnType<typeof getActiveRun>> | null = null;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', () => {
        if (!returnNullActive) return undefined;
        return HttpResponse.json({ run: null });
      }),
      http.get('/api/v1/projects/:projectId/runs/:runId', async () => {
        if (!holdConfirmation) return undefined;
        confirmStarted.resolve();
        await confirmHeld.promise;
        return HttpResponse.json(confirmedDetail);
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
    returnNullActive = true;
    traceReload = true;
    confirmedDetail = {
      ...run,
      state: 'SUCCEEDED',
      finishedAt: new Date(Date.parse(run.startedAt ?? run.createdAt) + 1_000).toISOString(),
      terminationReason: 'BUILD_SUCCEEDED',
      exitCode: 0,
    };
    const refetch = queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await confirmStarted.promise;

    await waitFor(() => expect(setRun).toHaveBeenCalledWith(null));
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
    expect(trace).toEqual(['terminal:null']);
    expect(screen.queryByText('Reloading workspace')).not.toBeInTheDocument();

    confirmHeld.resolve();
    await waitFor(() => expect(trace).toContain('reload'));
    expect(trace.filter((item) => item === 'terminal:null')).toHaveLength(1);
    reloadHeld.resolve();
    await refetch;
    const reloadIndex = trace.indexOf('reload');
    expect(trace.slice(0, reloadIndex)).toEqual(['terminal:null', 'terminal:SUCCEEDED']);
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
    expect(workspaceSessionStore.getState().openPaths).toContain(README);

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

  it.each(['SUCCEEDED', 'FAILED'] as const)('retries reload after a %s run with an expanded directory', async (state) => {
    const user = userEvent.setup();
    let failReloads = false;
    let checkConcurrentReads = false;
    let readInProgress = false;
    let concurrentReads = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/files/:resource', async () => {
        if (!checkConcurrentReads) return undefined;
        if (readInProgress) {
          concurrentReads += 1;
          return HttpResponse.json(
            { code: 'PROJECT_BUSY', message: 'Project is busy', traceId: 'trace-busy' },
            { status: 409 },
          );
        }
        readInProgress = true;
        await delay(30);
        readInProgress = false;
        return undefined;
      }),
      http.get('/api/v1/projects/:projectId/files/meta', ({ request }) => {
        if (new URL(request.url).searchParams.get('path') === 'src') {
          return HttpResponse.json({
            path: 'src', name: 'src', sizeBytes: null, mediaType: 'inode/directory',
            encoding: null, language: '', renderMode: 'MONACO_TEXT', blockReason: null,
          });
        }
        return undefined;
      }),
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
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    await screen.findByTestId('mock-editor');
    await user.click(screen.getByRole('treeitem', { name: 'src' }));
    expect(workspaceSessionStore.getState().expandedPaths.has(parseProjectRelativePath('src'))).toBe(true);
    const run = await lockShellWithActiveRun();
    failReloads = true;
    const result = transitionRun(ALICE_SEED_PROJECT_ID, run.id, {
      state,
      terminationReason: state === 'SUCCEEDED' ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED',
      exitCode: state === 'SUCCEEDED' ? 0 : 1,
    });
    expect(result.ok).toBe(true);
    await queryClient.invalidateQueries({ queryKey: runKeys.active(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(await screen.findByText(/workspace reload failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start run' })).toBeDisabled();

    failReloads = false;
    checkConcurrentReads = true;
    await user.click(screen.getByRole('button', { name: 'Retry workspace reload' }));
    await user.click(screen.getByRole('tab', { name: 'File' }));
    await waitUntilWritesUnlocked();
    expect(concurrentReads).toBe(0);
    expect(await screen.findByTestId('mock-editor')).toBeInTheDocument();
    expect(workspaceSessionStore.getState().activePath).toBe(POM);
    expect(workspaceSessionStore.getState().expandedPaths.has(parseProjectRelativePath('src'))).toBe(true);
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

describe('WorkbenchShell python dependencies', () => {
  async function renderEditablePythonShell(): Promise<ProjectSummary> {
    const created = await createProject({
      name: 'Python Deps Lab',
      templateId: 'python-console',
      mysql: false,
      redis: false,
      publicPorts: [],
    });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');
    workspaceSessionStore.getState().activateProject(ready.id);
    render(
      <AppProviders>
        <MemoryRouter>
          <WorkbenchShell project={ready} />
        </MemoryRouter>
      </AppProviders>,
    );
    await waitUntilWritesUnlocked();
    return ready;
  }

  async function createPythonProjectWithFile(name: string): Promise<ProjectSummary> {
    const created = await createProject({
      name,
      templateId: 'python-console',
      mysql: false,
      redis: false,
      publicPorts: [],
    });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');
    const tree = await listDirectory(ready.id, parseProjectDirectoryPath(''));
    await createEntry(ready.id, {
      kind: 'file',
      path: parseProjectRelativePath('notes.md'),
      expectedWorkspaceRevision: tree.workspaceRevision,
    });
    return ready;
  }

  function renderPythonShell(project: ProjectSummary) {
    workspaceSessionStore.getState().activateProject(project.id);
    return render(
      <AppProviders>
        <MemoryRouter>
          <WorkbenchShell project={project} />
        </MemoryRouter>
      </AppProviders>,
    );
  }

  async function openNotesAndMakeDirty(
    user: ReturnType<typeof userEvent.setup>,
    projectId: string,
  ): Promise<void> {
    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    expect(await screen.findByRole('tab', { name: /notes.md/ })).toBeInTheDocument();
    const path = parseProjectRelativePath('notes.md');
    const uri = toProjectModelUri(projectId, path);
    await waitFor(() => {
      expect(monaco.editor.getModel(uri)).not.toBeNull();
    });
    const model = monaco.editor.getModel(uri)!;
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: '# dirty notes' }],
      () => null,
    );
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /notes.md/ })).toHaveTextContent('*');
    });
  }

  it('shows the Dependencies tab and form only on a python workbench', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    await renderEditablePythonShell();

    const dependencies = screen.getByRole('tab', { name: 'Dependencies' });
    expect(dependencies).toBeEnabled();
    await user.click(dependencies);
    expect(await screen.findByLabelText('Package name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();

    cleanup();
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();
    expect(screen.queryByRole('tab', { name: 'Dependencies' })).not.toBeInTheDocument();
  }, 15_000);

  it('locks the form behind the recovery entry after a lost response; checking reloads and unlocks', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await renderEditablePythonShell();
    setDependencyScenario('lost-response');

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // The result is unknown: the entry appears and no further change may start.
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check dependency change' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeDisabled();

    setDependencyScenario('normal');
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    await waitFor(() => {
      expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Add dependency' })).toBeEnabled();
    // The recovered reload re-read the workspace with the committed dependency files.
    expect(await screen.findByRole('treeitem', { name: 'pyproject.toml' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBeNull();
  }, 20_000);

  it('logout clears the saved dependency operation so the next user starts clean', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const created = await createProject({
      name: 'Python Logout Deps',
      templateId: 'python-console',
      mysql: false,
      redis: false,
      publicPorts: [],
    });
    await getProject(created.id);
    const ready = await getProject(created.id);
    expect(ready.state).toBe('READY');
    // The full router is needed so logout can navigate to the login page.
    renderApp({ initialEntries: [`/projects/${ready.id}`] });
    await waitUntilWritesUnlocked();
    setDependencyScenario('lost-response');

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', ready.id))).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', ready.id))).toBeNull();

    setDependencyScenario('normal');
  }, 20_000);


  it('surfaces a failed post-recovery reload and retries it instead of staying silent', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await renderEditablePythonShell();
    setDependencyScenario('lost-response');

    let failRootTree = false;
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (failRootTree && path === '') {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock recovery reload failure', traceId: 'trace-recovery-reload' },
            { status: 500 },
          );
        }
        return undefined;
      }),
    );

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();

    failRootTree = true;
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    // The change is committed but the surface is stale: the shell must say so.
    await waitFor(() => {
      expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('依赖变更已确认，但工作区重新加载失败。'),
    ).toBeInTheDocument();

    failRootTree = false;
    await user.click(screen.getByRole('button', { name: 'Reload workspace' }));
    await waitFor(() => {
      expect(
        screen.queryByText('依赖变更已确认，但工作区重新加载失败。'),
      ).not.toBeInTheDocument();
    });
    // The retried reload reads the committed workspace.
    expect(await screen.findByRole('treeitem', { name: 'pyproject.toml' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBeNull();

    setDependencyScenario('normal');
  }, 20_000);

  it('closes the write gate while a dependency change is in flight and reopens after a safe rejection', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/projects/:projectId/python-dependencies', async () => {
        await held;
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Gate In Flight');
    renderPythonShell(project);
    await waitUntilWritesUnlocked();

    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    expect(await screen.findByRole('tab', { name: /notes.md/ })).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // The same write surfaces the active-Run lock closes are closed mid-request.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();

    // The editor itself is read-only while the request is held, also after
    // switching back to the File tab.
    await user.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByTestId('mock-editor')).toHaveAttribute('data-readonly', 'true');

    setDependencyScenario('resolution-failed');
    release();
    await waitUntilWritesUnlocked();
    // The rejection alert lives in the now-inactive Dependencies panel.
    expect(await screen.findByRole('alert', { hidden: true })).toHaveTextContent(
      /依赖解析失败/,
    );
    expect(screen.getByTestId('mock-editor')).toHaveAttribute('data-readonly', 'false');

    setDependencyScenario('normal');
  }, 15_000);

  it('keeps the write gate closed while a committed dependency change reloads the workspace', async () => {
    const user = userEvent.setup();
    let holdTree = false;
    let releaseTree = () => {};
    const heldTree = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (holdTree && path === '') {
          await heldTree;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Gate Reload');
    renderPythonShell(project);
    // The initial tree load must complete before reload requests are held.
    expect(await screen.findByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();
    await waitUntilWritesUnlocked();
    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    expect(await screen.findByRole('tab', { name: /notes.md/ })).toBeInTheDocument();
    holdTree = true;

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));

    // Committed: the panel reloads the workspace and the gate stays closed.
    await screen.findByText('正在重新加载工作区');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });

    releaseTree();
    await waitUntilWritesUnlocked();
    expect(screen.queryByText('正在重新加载工作区')).not.toBeInTheDocument();
    expect(await screen.findByTestId('mock-editor')).toHaveAttribute('data-readonly', 'false');
  }, 15_000);

  it('closes the write gate at mount while an unconfirmed dependency operation is known', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Gate Unconfirmed Mount');
    sessionStorage.setItem(
      pythonDependencyStorageKey('usr-alice', project.id),
      '33333333-3333-4333-8333-333333333333',
    );
    renderPythonShell(project);
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();

    // The run authority itself resolves (Start run enables) but the gate stays closed.
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    });
    await user.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
  }, 15_000);

  it('never starts a dependency change from a dirty workspace, so the success reload cannot run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Gate Dirty');
    renderPythonShell(project);
    await waitUntilWritesUnlocked();

    // The dirty buffer is exactly the content a success reload would destroy.
    await openNotesAndMakeDirty(user, project.id);
    const notesPath = parseProjectRelativePath('notes.md');
    expect(
      workspaceBufferRegistry.get(project.id, notesPath)?.snapshot().content,
    ).toBe('# dirty notes');

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    const add = screen.getByRole('button', { name: 'Add dependency' });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute('title', '请先保存或放弃文件修改');
    await user.click(add);

    // No dependency request was issued, so the success reload is unreachable.
    const dependencyPosts = fetchSpy.mock.calls.filter(
      (call) => fetchMethod(call) === 'POST' && /\/python-dependencies$/.test(fetchPathname(call)),
    );
    expect(dependencyPosts).toHaveLength(0);
    expect(screen.getByRole('tab', { name: /notes.md/, hidden: true })).toHaveTextContent('*');
    fetchSpy.mockRestore();
  }, 15_000);

  it('keeps the write gate closed while the recovery reload runs and releases it after success', async () => {
    const user = userEvent.setup();
    let holdTree = false;
    let releaseTree = () => {};
    const heldTree = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (holdTree && path === '') {
          await heldTree;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Recovery Reload Gate');
    renderPythonShell(project);
    await waitUntilWritesUnlocked();
    setDependencyScenario('lost-response');

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();

    setDependencyScenario('normal');
    holdTree = true;
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    // The unconfirmed entry is resolved, but the authoritative reload is still in
    // flight: the write gate must stay closed (delayed recovery).
    await waitFor(() => {
      expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });

    releaseTree();
    await waitUntilWritesUnlocked();
    expect(await screen.findByRole('treeitem', { name: 'pyproject.toml' }, { timeout: 10_000 })).toBeInTheDocument();

    setDependencyScenario('normal');
  }, 20_000);

  it('keeps the editor read-only while a failed recovery reload offers Retry and releases it after success', async () => {
    const user = userEvent.setup();
    let failRootTree = false;
    let holdTree = false;
    let releaseTree = () => {};
    const heldTree = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/files/tree', async ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (failRootTree && path === '') {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock recovery reload failure', traceId: 'trace-recovery-gate' },
            { status: 500 },
          );
        }
        if (holdTree && path === '') {
          await heldTree;
        }
        return undefined;
      }),
    );
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Recovery Retry Gate');
    renderPythonShell(project);
    await waitUntilWritesUnlocked();
    await user.click(screen.getByRole('treeitem', { name: 'notes.md' }));
    expect(await screen.findByRole('tab', { name: /notes.md/ })).toBeInTheDocument();
    setDependencyScenario('lost-response');

    await user.click(screen.getByRole('tab', { name: 'Dependencies' }));
    await user.type(screen.getByLabelText('Package name'), 'httpx');
    await user.click(screen.getByRole('button', { name: 'Add dependency' }));
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();

    setDependencyScenario('normal');
    failRootTree = true;
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));

    // The reload failed, but its Retry affordance exists: the gate must stay closed
    // so no dirty buffer can reach the retry (dirty-retry regression).
    expect(
      await screen.findByText('依赖变更已确认，但工作区重新加载失败。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'File' }));
    expect(await screen.findByTestId('mock-editor')).toHaveAttribute('data-readonly', 'true');

    // The retry runs against a clean workspace and only then releases the gate.
    failRootTree = false;
    holdTree = true;
    await user.click(screen.getByRole('button', { name: 'Reload workspace' }));
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    releaseTree();
    await waitUntilWritesUnlocked();
    expect(screen.getByTestId('mock-editor')).toHaveAttribute('data-readonly', 'false');
    expect(
      screen.queryByText('依赖变更已确认，但工作区重新加载失败。'),
    ).not.toBeInTheDocument();

    setDependencyScenario('normal');
  }, 20_000);

  const SERVER_PENDING_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
  const MIDFLIGHT_CLIENT_OPERATION_ID = '66666666-6666-4666-8666-666666666666';

  async function registerPendingMockOperation(
    project: ProjectSummary,
    operationId: string,
  ): Promise<void> {
    const tree = await listDirectory(project.id, parseProjectDirectoryPath(''));
    registerMockDependencyOperation({
      projectId: project.id,
      operationId,
      fingerprint: mockDependencyRequestFingerprint(
        project.id,
        'ADD',
        'httpx',
        null,
        tree.workspaceRevision,
      ),
      action: 'ADD',
      packageName: 'httpx',
      version: null,
    });
  }

  function pendingDiscoveryGetCount(spy: { mock: { calls: unknown[][] } }): number {
    return spy.mock.calls.filter(
      (call) =>
        fetchMethod(call) === 'GET' &&
        /\/python-dependencies\/pending$/.test(fetchPathname(call)),
    ).length;
  }

  it('discovers a server-pending dependency operation on a READY workbench and engages recovery', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Pending Discovery');
    await registerPendingMockOperation(project, SERVER_PENDING_OPERATION_ID);

    // Hold the run authority so the closed write gate can only come from the
    // discovered operation, not from a loading authority.
    let releaseAuthority = () => {};
    const authorityHeld = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', async () => {
        await authorityHeld;
        return HttpResponse.json({ run: null });
      }),
    );
    renderPythonShell(project);

    // A new browser session has no stored id: the shell discovers the durable
    // PENDING itself, persists the identity and engages the recovery entry.
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBe(
      SERVER_PENDING_OPERATION_ID,
    );

    releaseAuthority();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled();
    });
    await user.click(screen.getByRole('tab', { name: 'File' }));
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();

    // Checking the discovered operation recovers the dead end end to end.
    await user.click(screen.getByRole('button', { name: 'Check dependency change' }));
    await waitFor(() => {
      expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    });
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBeNull();
    expect(
      await screen.findByRole('treeitem', { name: 'pyproject.toml' }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    await waitUntilWritesUnlocked();
  }, 20_000);

  it('renders nothing and issues the pending query once when no operation is pending', async () => {
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Empty');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPythonShell(project);
    await waitUntilWritesUnlocked();
    expect(await screen.findByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();

    await waitFor(() => {
      expect(pendingDiscoveryGetCount(fetchSpy)).toBe(1);
    });
    expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    expect(
      screen.queryByText('无法核对待确认的依赖变更。'),
    ).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  }, 15_000);

  it('offers a retry affordance when the pending query fails and a retry that finds nothing renders nothing', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Failure');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let failPending = true;
    server.use(
      http.get('/api/v1/projects/:projectId/python-dependencies/pending', () => {
        if (failPending) {
          // PROJECT_BUSY is what the real backend answers under lease contention.
          return HttpResponse.json(
            { code: 'PROJECT_BUSY', message: 'Project is busy', traceId: 'trace-pending-busy' },
            { status: 409 },
          );
        }
        return undefined;
      }),
    );
    renderPythonShell(project);
    await waitUntilWritesUnlocked();

    // A failed discovery must not fabricate absence: the shell says so and offers a
    // retry, but only after the shared PROJECT_BUSY read budget is exhausted.
    expect(
      await screen.findByText('无法核对待确认的依赖变更。', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(PROJECT_BUSY_READ_MAX_RETRIES + 1);

    failPending = false;
    await user.click(screen.getByRole('button', { name: 'Retry pending dependency check' }));

    // The retry found nothing: the affordance disappears and nothing is rendered.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry pending dependency check' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText('无法核对待确认的依赖变更。'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  }, 15_000);

  it('a retry of a failed discovery re-queries the server and recovers a pending operation', async () => {
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Retry Recovers');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let failPending = true;
    server.use(
      http.get('/api/v1/projects/:projectId/python-dependencies/pending', () => {
        if (failPending) {
          // PROJECT_BUSY is what the real backend answers under lease contention.
          return HttpResponse.json(
            { code: 'PROJECT_BUSY', message: 'Project is busy', traceId: 'trace-pending-retry' },
            { status: 409 },
          );
        }
        return undefined;
      }),
    );
    renderPythonShell(project);
    await waitUntilWritesUnlocked();
    expect(
      await screen.findByText('无法核对待确认的依赖变更。', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(PROJECT_BUSY_READ_MAX_RETRIES + 1);

    // The operation becomes server-pending BEFORE the user retries: the retry's
    // re-query must find it. A retry that only hid the banner would fabricate
    // absence — exactly the dead end the discovery exists to prevent.
    await registerPendingMockOperation(project, SERVER_PENDING_OPERATION_ID);
    failPending = false;
    await user.click(screen.getByRole('button', { name: 'Retry pending dependency check' }));

    // The retry re-queried (GET count 4 -> 5, succeeded on its first attempt) and
    // the discovered operation engages the recovery entry from a previously empty
    // surface.
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(PROJECT_BUSY_READ_MAX_RETRIES + 2);
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBe(
      SERVER_PENDING_OPERATION_ID,
    );
    expect(
      screen.queryByText('无法核对待确认的依赖变更。'),
    ).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  }, 15_000);

  it('retries a transient PROJECT_BUSY pending failure and then discovers normally', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Busy Recovered');
    let busyHits = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/python-dependencies/pending', () => {
        busyHits += 1;
        if (busyHits === 1) {
          // PROJECT_BUSY is what the real backend answers under lease contention.
          return HttpResponse.json(
            { code: 'PROJECT_BUSY', message: 'Project is busy', traceId: 'trace-pending-busy-once' },
            { status: 409 },
          );
        }
        return undefined;
      }),
    );
    await registerPendingMockOperation(project, SERVER_PENDING_OPERATION_ID);
    renderPythonShell(project);

    // The busy read recovers within the shared retry budget: the pending operation
    // is discovered and the red banner never appears.
    expect(
      await screen.findByText('依赖变更尚未确认', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('无法核对待确认的依赖变更。'),
    ).not.toBeInTheDocument();
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(2);
    fetchSpy.mockRestore();
  }, 20_000);

  it('does not retry a pending failure that is not PROJECT_BUSY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Forbidden');
    server.use(
      http.get('/api/v1/projects/:projectId/python-dependencies/pending', () =>
        HttpResponse.json(
          { code: 'FORBIDDEN', message: 'Not allowed', traceId: 'trace-pending-forbidden' },
          { status: 403 },
        ),
      ),
    );
    renderPythonShell(project);
    await waitUntilWritesUnlocked();

    // A non-PROJECT_BUSY failure is a real error: no busy retry, the banner and its
    // Retry affordance appear after the single attempt.
    expect(
      await screen.findByText('无法核对待确认的依赖变更。'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Retry pending dependency check' }),
    ).toBeInTheDocument();
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(1);
    fetchSpy.mockRestore();
  }, 15_000);

  it('ignores the discovered pending operation when an id is stored while the query is in flight', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Midflight');
    await registerPendingMockOperation(project, SERVER_PENDING_OPERATION_ID);

    let releaseAuthority = () => {};
    const authorityHeld = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let releasePending = () => {};
    const pendingHeld = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    let pendingCaptured = false;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', async () => {
        await authorityHeld;
        return HttpResponse.json({ run: null });
      }),
      http.get('/api/v1/projects/:projectId/python-dependencies/pending', async () => {
        pendingCaptured = true;
        await pendingHeld;
        return undefined;
      }),
    );
    renderPythonShell(project);
    await waitFor(() => {
      expect(pendingCaptured).toBe(true);
    });

    // The client saved its own operation while the discovery query ran.
    sessionStorage.setItem(
      pythonDependencyStorageKey('usr-alice', project.id),
      MIDFLIGHT_CLIENT_OPERATION_ID,
    );
    releasePending();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    releaseAuthority();

    // If the discovery result were (wrongly) adopted, the write gate would stay
    // closed and this unlock would time out.
    await waitUntilWritesUnlocked();

    // Design 6.1: the discovery result is ignored entirely — no adoption, no
    // overwrite of the client-saved id, no re-issued query.
    expect(screen.queryByText('依赖变更尚未确认')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(pythonDependencyStorageKey('usr-alice', project.id))).toBe(
      MIDFLIGHT_CLIENT_OPERATION_ID,
    );
    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(1);
    fetchSpy.mockRestore();
  }, 15_000);

  it('does not issue the pending query when an unconfirmed operation is already stored', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await authenticateAsAlice();
    const project = await createPythonProjectWithFile('Discovery Known');
    sessionStorage.setItem(
      pythonDependencyStorageKey('usr-alice', project.id),
      '77777777-7777-4777-8777-777777777777',
    );
    renderPythonShell(project);
    expect(await screen.findByText('依赖变更尚未确认')).toBeInTheDocument();
    expect(await screen.findByRole('treeitem', { name: 'notes.md' })).toBeInTheDocument();

    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(0);
    fetchSpy.mockRestore();
  }, 15_000);

  it('never issues the pending query for a non-python project', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    expect(pendingDiscoveryGetCount(fetchSpy)).toBe(0);
    fetchSpy.mockRestore();
  }, 15_000);
});

describe('WorkbenchShell agent task panel', () => {
  const AGENT_TASK_ID = '0b8fd38f-0f9e-4c28-9c48-3f5f4a2b1c11';
  const AGENT_TASKS_URL = `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/agent-tasks`;

  function agentTask(overrides: Partial<AgentTaskSnapshot> = {}): AgentTaskSnapshot {
    return {
      taskId: AGENT_TASK_ID,
      state: 'RUNNING',
      workspaceRevision: 'mock-rev-0001',
      writesLocked: true,
      progress: [{ seq: 1, kind: 'message', text: 'Reading pom.xml', truncated: false }],
      changedPaths: [],
      summary: null,
      failureCode: null,
      ...overrides,
    };
  }

  function agentCurrentNotFound() {
    return HttpResponse.json(
      { code: 'ENTRY_NOT_FOUND', message: 'Task not found', traceId: 'trace-agent-none' },
      { status: 404 },
    );
  }

  async function occupyWorkspace(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
  }

  it('pauses the current task and reloads saved facts on safe release even when its revision is unchanged', async () => {
    let current = agentTask();
    let occupied = true, treeReads = 0;
    const pausedIds: string[] = [];
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => occupied ? HttpResponse.json(current) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, () => HttpResponse.json(current)),
      http.post(`${AGENT_TASKS_URL}/:taskId/pause`, ({ params }) => {
        pausedIds.push(String(params.taskId));
        current = agentTask({ state: 'NEEDS_ATTENTION', failureCode: 'AI_CLOSING', closeReasonCode: 'AI_PAUSED_BY_OWNER' });
        return HttpResponse.json(current);
      }),
      http.get('/api/v1/projects/:projectId/files/tree', () => { treeReads++; return undefined; }),
    );
    await authenticateAsAlice(); renderShell(); await loadedRoot();
    await userEvent.click(screen.getByRole('tab', { name: 'AI' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause & take over' }));
    expect(pausedIds).toEqual([AGENT_TASK_ID]);
    await screen.findByText('Stopping and verifying');
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    const before = treeReads;
    current = agentTask({ state: 'FAILED', writesLocked: false, closeReasonCode: 'AI_PAUSED_BY_OWNER' }); occupied = false;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) }); });
    await waitUntilWritesUnlocked();
    await waitFor(() => expect(treeReads).toBeGreaterThan(before));
  }, 15000);

  it('keeps editing locked when current task authority is unavailable without a cached task', async () => {
    server.use(http.get(`${AGENT_TASKS_URL}/current`,()=>HttpResponse.json({code:'INTERNAL_ERROR',message:'unavailable',traceId:'test'},{status:503})));
    await authenticateAsAlice(); renderShell(); await loadedRoot();
    await userEvent.click(screen.getByRole('tab',{name:'AI'}));
    await screen.findByText('Could not load the agent task status.');
    expect(screen.getByRole('button',{name:'New file'})).toBeDisabled();
  });

  it('reloads a latest paused conversation after re-entry without a retained current task', async () => {
    const conversationId='11111111-1111-4111-8111-111111111111';
    let treeReads=0;
    const url=`/api/v1/projects/${ALICE_SEED_PROJECT_ID}/conversations`;
    const meta={conversationId,title:'re-entry',headSeq:0,lastTaskId:AGENT_TASK_ID,activeTaskId:null,usage:null,compactRequestId:null,compactState:null,compactFailureCode:null};
    server.use(http.get(`${AGENT_TASKS_URL}/current`,agentCurrentNotFound),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`,()=>HttpResponse.json(agentTask({state:'FAILED',writesLocked:false,conversationId,closeReasonCode:'AI_PAUSED_BY_OWNER'}))),
      http.get(url,()=>HttpResponse.json({items:[meta],nextCursor:null})),
      http.get(`${url}/${conversationId}`,()=>HttpResponse.json(meta)),
      http.get(`${url}/${conversationId}/entries`,()=>HttpResponse.json({items:[],nextBeforeSeq:null,nextBeforeOffset:null})),
      http.get('/api/v1/projects/:projectId/files/tree',()=>{treeReads++;return undefined;}));
    await authenticateAsAlice(); renderShell(); await loadedRoot();
    await userEvent.click(screen.getByRole('tab',{name:'AI'}));
    await screen.findByText('Paused');
    await waitFor(()=>expect(treeReads).toBeGreaterThan(1));
    await expect(screen.findByRole('button',{name:'Continue task'})).resolves.toBeEnabled();
  },15000);

  it('ends the current occupying task from history, retries safely and unlocks only after real settlement', async () => {
    const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
    const historicalId = '44444444-4444-4444-8444-444444444444';
    let current = agentTask({ conversationId: a });
    const closedIds: string[] = [];
    let releaseError!: () => void;
    const held = new Promise<void>(resolve => { releaseError = resolve; });
    const base = { headSeq: 0, lastTaskId: historicalId, activeTaskId: null, usage: null, compactRequestId: null, compactState: null, compactFailureCode: null };
    const url = `/api/v1/projects/${ALICE_SEED_PROJECT_ID}/conversations`;
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => HttpResponse.json(current)),
      http.get(`${AGENT_TASKS_URL}/${historicalId}`, () => HttpResponse.json(agentTask({ taskId: historicalId, conversationId: b, state: 'COMPLETED', writesLocked: false }))),
      http.post(`${AGENT_TASKS_URL}/:taskId/close`, async ({ params }) => {
        closedIds.push(String(params.taskId));
        if (closedIds.length === 1) { await held; return HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'private-token-do-not-show', traceId: 'trace-close' }, { status: 500 }); }
        current = agentTask({ conversationId: a, state: 'NEEDS_ATTENTION', failureCode: 'AI_CLOSING' });
        return HttpResponse.json(current);
      }),
      http.get(url, () => HttpResponse.json({ items: [{ ...base, conversationId: a, title: '会话 A' }, { ...base, conversationId: b, title: '会话 B' }], nextCursor: null })),
      http.get(`${url}/:id`, ({ params }) => HttpResponse.json({ ...base, conversationId: params.id, title: '历史会话' })),
      http.get(`${url}/:id/entries`, () => HttpResponse.json({ items: [], nextBeforeSeq: null, nextBeforeOffset: null })),
    );
    await authenticateAsAlice();
    sessionStorage.setItem(`manao.agent-conversation.usr-alice.${ALICE_SEED_PROJECT_ID}`, b);
    sessionStorage.setItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`, JSON.stringify({ taskId: AGENT_TASK_ID, conversationId: a }));
    renderShell(); await loadedRoot();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'AI' }));
    await screen.findByRole('heading', { name: '历史会话' });
    await user.click(screen.getByRole('button', { name: 'End task' }));
    await waitFor(() => expect(closedIds).toEqual([AGENT_TASK_ID]));
    expect(screen.getByRole('button', { name: 'End task' })).toBeDisabled();
    releaseError();
    expect(await screen.findByText(/Could not end the task/)).toHaveTextContent('INTERNAL_ERROR');
    expect(screen.queryByText(/private-token-do-not-show/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End task' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'End task' }));
    expect(await screen.findByRole('button', { name: 'Retry ending task' })).toBeEnabled();
    expect(screen.getByRole('status', { name: 'Task settlement' })).toHaveTextContent(/Waiting for confirmation/);
    expect(closedIds).toEqual([AGENT_TASK_ID, AGENT_TASK_ID]);
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(sessionStorage.getItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`)).not.toBeNull();
    current = agentTask({ conversationId: a, state: 'FAILED', writesLocked: false, failureCode: 'AI_CLOSED' });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'New file' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retry ending task' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(`manao.agent-task.id.usr-alice.${ALICE_SEED_PROJECT_ID}`)).toBeNull();
  }, 15_000);

  it('opens AI from the occupied Stop control and restores Stop after true task release', async () => {
    await authenticateAsAlice(); await seedLockingRun();
    let current = agentTask();
    server.use(http.get(`${AGENT_TASKS_URL}/current`, () => HttpResponse.json(current)));
    renderShell(); await loadedRoot();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeDisabled();
    expect(screen.getByText(/AI task is controlling the application/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Open AI task' }));
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true');
    current = agentTask({ state: 'FAILED', writesLocked: false, failureCode: 'AI_CLOSED' });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) }); });
    await user.click(screen.getByRole('tab', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop run' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Open AI task' })).not.toBeInTheDocument();
  }, 15_000);

  it('shows the AI tab and keeps the workspace editable while no task occupies the project', async () => {
    server.use(http.get(`${AGENT_TASKS_URL}/current`, () => agentCurrentNotFound()));
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    expect(screen.getByRole('tab', { name: 'AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New file' })).toBeEnabled();
  });

  it('keeps AI start blocked while Run authority is unavailable', async () => {
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => agentCurrentNotFound()),
      http.get('/api/v1/projects/:projectId/runs/active', () => HttpResponse.json({ code: 'UNAVAILABLE', message: 'Unavailable', traceId: 'trace-run' }, { status: 503 })),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'AI' }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(await screen.findByText('RUN_AUTHORITY_UNKNOWN')).toBeInTheDocument();
  });

  it('keeps a structured HTTP validation error with no Run ID visible without invalid navigation', async () => {
    const task = agentTask({ state: 'COMPLETED', writesLocked: false,
      progress: [{ seq: 1, kind: 'tool_end', text: 'app_http_get http-empty', truncated: false }] });
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => HttpResponse.json(task)),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}/tools/http-empty`, () => HttpResponse.json({
        toolCallId: 'http-empty', toolName: 'app_http_get', data: {
          kind: 'app_http_get', runId: '', path: '/health', statusCode: null, contentType: null,
          body: '', truncated: false, error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
        },
      })),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedRoot();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'AI' }));
    await user.click(screen.getByRole('button', { name: 'View HTTP result' }));
    expect(await screen.findByText(/VALIDATION_ERROR/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View run' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the existing Run panel from an application result and keeps a completed task with an active Run read-only', async () => {
    await authenticateAsAlice();
    await seedLockingRun();
    const run = getActiveRun(ALICE_SEED_PROJECT_ID)!;
    const task = agentTask({ state: 'COMPLETED', writesLocked: false,
      progress: [{ seq: 1, kind: 'tool_end', text: 'application app-real', truncated: false }] });
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => HttpResponse.json(task)),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}/tools/app-real`, () => HttpResponse.json({
        toolCallId: 'app-real', toolName: 'application', data: {
          kind: 'application', action: 'status', run: { id: run.id, state: run.state, requestedWorkspaceRevision: run.requestedWorkspaceRevision,
            firstReadyAt: null, expiresAt: null, finishedAt: null, exitCode: null, terminationReason: null },
          activeRunId: run.id, stoppedConfirmed: false, logs: null,
        },
      })),
    );
    renderShell();
    await loadedRoot();
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'AI' }));
    await user.click(screen.getByRole('button', { name: 'View application result' }));
    await user.click(await screen.findByRole('button', { name: 'View run' }));
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  }, 15000);

  it('locks the editor, file tree and Run start while an agent task occupies the workspace', async () => {
    const user = userEvent.setup();
    const task = agentTask();
    let occupying = false;
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => (occupying ? HttpResponse.json(task) : agentCurrentNotFound())),
      http.get(`${AGENT_TASKS_URL}/${task.taskId}`, () => HttpResponse.json(task)),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    occupying = true;
    await occupyWorkspace();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    expect(await screen.findByTestId('mock-editor')).toHaveAttribute('data-readonly', 'true');

    await user.click(screen.getByRole('tab', { name: 'Run' }));
    const start = await screen.findByRole('button', { name: 'Start run' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', runPreconditionDescription('AGENT_TASK_ACTIVE'));
  }, 15_000);

  it('does not POST close when the workbench unmounts', async () => {
    const task = agentTask();
    let occupying = false;
    let closePosts = 0;
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () => (occupying ? HttpResponse.json(task) : agentCurrentNotFound())),
      http.post(`${AGENT_TASKS_URL}/${task.taskId}/close`, () => {
        closePosts += 1;
        return HttpResponse.json(task);
      }),
    );
    await authenticateAsAlice();
    const view = renderShell();
    await loadedEditable();

    occupying = true;
    await occupyWorkspace();
    view.unmount();
    expect(closePosts).toBe(0);
  }, 15_000);

  it('refreshes the workspace when the agent task writes files and unlocks after it settles', async () => {
    const user = userEvent.setup();
    const settledSnapshot = agentTask({
      state: 'COMPLETED',
      writesLocked: false,
      summary: 'Fixed the failing test',
      changedPaths: ['pom.xml'],
    });
    const agentPomBody = '<project xmlns="http://maven.apache.org/POM/4.0.0"><agent-edit /></project>';
    let occupying = false;
    let settled = false;
    let agentWrote = false;
    let agentRevision = 'mock-rev-0001';
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () =>
        occupying ? HttpResponse.json(agentTask({ workspaceRevision: agentRevision })) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, () =>
        HttpResponse.json(settled ? settledSnapshot : agentTask({ workspaceRevision: agentRevision }))),
      http.get('/api/v1/projects/:projectId/files/content', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path');
        if (!agentWrote || path !== 'pom.xml') {
          return undefined;
        }
        return HttpResponse.json({
          path: 'pom.xml',
          content: agentPomBody,
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    await user.click(screen.getByRole('treeitem', { name: 'pom.xml' }));
    const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    await waitFor(() => {
      expect(monaco.editor.getModel(uri)).not.toBeNull();
    });
    expect(monaco.editor.getModel(uri)!.getValue()).not.toContain('<agent-edit />');

    occupying = true;
    await occupyWorkspace();

    // The agent writes a new revision: the shell reloads and disposes the stale model.
    agentWrote = true;
    agentRevision = 'mock-rev-0002';
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => {
      expect(monaco.editor.getModel(uri)?.getValue()).toContain('<agent-edit />');
    });
    // Still occupying: the agent owns every write until it settles.
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();

    settled = true;
    occupying = false;
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });
    await waitUntilWritesUnlocked();
    expect(monaco.editor.getModel(uri)?.getValue()).toContain('<agent-edit />');
  }, 15_000);

  it('keeps writes locked when the agent-driven reload fails and releases them only after Retry succeeds', async () => {
    const user = userEvent.setup();
    const settledSnapshot = agentTask({ state: 'COMPLETED', writesLocked: false });
    let occupying = false;
    let settled = false;
    let agentRevision = 'mock-rev-0001';
    let failReloadTrees = false;
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () =>
        occupying ? HttpResponse.json(agentTask({ workspaceRevision: agentRevision })) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, () =>
        HttpResponse.json(settled ? settledSnapshot : agentTask({ workspaceRevision: agentRevision }))),
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (failReloadTrees && path === '') {
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

    occupying = true;
    await occupyWorkspace();

    agentRevision = 'mock-rev-0002';
    failReloadTrees = true;
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });
    expect(
      await screen.findByText(/agent changed the workspace files, but reloading them failed/i),
    ).toBeInTheDocument();

    // The task settles while the reload is still failed: the workspace stays locked.
    settled = true;
    occupying = false;
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'Reload workspace' })).toBeEnabled();

    // The AI panel shares the lock: Start stays disabled while the reload is
    // failed, so the panel cannot bypass the read-only workspace.
    await user.click(screen.getByRole('tab', { name: 'AI' }));
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();

    failReloadTrees = false;
    await user.click(screen.getByRole('button', { name: 'Reload workspace' }));
    await waitUntilWritesUnlocked();
    expect(screen.queryByRole('button', { name: 'Reload workspace' })).not.toBeInTheDocument();
  }, 15_000);

  it('does not replace dirty buffers when the agent changes files and surfaces the conflict', async () => {
    const user = userEvent.setup();
    let occupying = false;
    let agentWrote = false;
    let agentRevision = 'mock-rev-0001';
    let rootTreeHits = 0;
    const agentPomBody = '<project xmlns="http://maven.apache.org/POM/4.0.0"><agent-edit /></project>';
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () =>
        occupying ? HttpResponse.json(agentTask({ workspaceRevision: agentRevision })) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, () => HttpResponse.json(agentTask({ workspaceRevision: agentRevision }))),
      http.get('/api/v1/projects/:projectId/files/tree', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path') ?? '';
        if (path === '') {
          rootTreeHits += 1;
        }
        return undefined;
      }),
      http.get('/api/v1/projects/:projectId/files/content', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path');
        if (!agentWrote || path !== 'pom.xml') {
          return undefined;
        }
        return HttpResponse.json({
          path: 'pom.xml',
          content: agentPomBody,
          workspaceRevision: 'mock-rev-0002',
        });
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();
    await dirtyPomFromWorkbench(user);
    const uri = toProjectModelUri(ALICE_SEED_PROJECT_ID, POM);
    const dirtyContent = monaco.editor.getModel(uri)!.getValue();

    occupying = true;
    await occupyWorkspace();
    rootTreeHits = 0;
    agentWrote = true;
    agentRevision = 'mock-rev-0002';
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });

    expect(await screen.findByText(/save or discard your unsaved changes/i)).toBeInTheDocument();
    expect(monaco.editor.getModel(uri)?.getValue()).toBe(dirtyContent);
    expect(workspaceSessionStore.getState().dirtyPaths.has(POM)).toBe(true);
    // No reload ran into the dirty buffer.
    expect(rootTreeHits).toBe(0);

    act(() => {
      workspaceSessionStore.getState().setDirty(POM, false);
    });
    await user.click(screen.getByRole('button', { name: 'Reload workspace' }));
    await waitFor(() => {
      expect(monaco.editor.getModel(uri)?.getValue()).toContain('<agent-edit />');
    });
  }, 15_000);

  it('keeps writes locked while the settled snapshot is loading and unlocks once it confirms', async () => {
    const settledSnapshot = agentTask({ state: 'COMPLETED', writesLocked: false, summary: 'Fixed' });
    let occupying = false;
    let releaseSettled = () => {};
    const holdSettled = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    });
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () =>
        occupying ? HttpResponse.json(agentTask()) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, async () => {
        // The final snapshot request hangs: the release must not unlock early.
        await holdSettled;
        return HttpResponse.json(settledSnapshot);
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    occupying = true;
    await occupyWorkspace();
    occupying = false;
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });

    // The occupying task released but the final revision is not confirmed yet.
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();

    act(() => {
      releaseSettled();
    });
    await waitUntilWritesUnlocked();
  }, 15_000);

  it('keeps writes locked when the settled snapshot request fails until the retry succeeds', async () => {
    const user = userEvent.setup();
    const settledSnapshot = agentTask({ state: 'COMPLETED', writesLocked: false, summary: 'Fixed' });
    let occupying = false;
    let settledFails = true;
    server.use(
      http.get(`${AGENT_TASKS_URL}/current`, () =>
        occupying ? HttpResponse.json(agentTask()) : agentCurrentNotFound()),
      http.get(`${AGENT_TASKS_URL}/${AGENT_TASK_ID}`, () => {
        if (settledFails) {
          return HttpResponse.json(
            { code: 'INTERNAL_ERROR', message: 'Mock settled failure', traceId: 'trace-settled' },
            { status: 500 },
          );
        }
        return HttpResponse.json(settledSnapshot);
      }),
    );
    await authenticateAsAlice();
    renderShell();
    await loadedEditable();

    occupying = true;
    await occupyWorkspace();
    occupying = false;
    await queryClient.invalidateQueries({ queryKey: agentTaskKeys.current(ALICE_SEED_PROJECT_ID) });

    // The failed final-snapshot read stays user-visible and keeps the gate closed.
    expect(await screen.findByText(/final result could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New file' })).toBeDisabled();

    settledFails = false;
    await user.click(screen.getByRole('button', { name: 'Retry loading the result' }));
    await waitUntilWritesUnlocked();
    expect(screen.queryByRole('button', { name: 'Retry loading the result' })).not.toBeInTheDocument();
  }, 15_000);
});
