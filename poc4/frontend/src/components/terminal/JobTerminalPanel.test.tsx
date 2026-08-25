import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '@/app/appRuntime';
import { parseRunId, type RunState } from '@/contracts/run';
import type { JobTerminalSnapshot } from '@/features/terminal/JobTerminalController';
import { server } from '@/mocks/node';
import type {
  JobTerminalPanelController,
  JobTerminalPanelControllerFactory,
  JobTerminalPanelControllerFactoryOptions,
} from './JobTerminalPanel';
import { JobTerminalPanel } from './JobTerminalPanel';
import { resolveTerminalAuditRunId } from './JobTerminalPanelState';
import { CloseTerminalDialog } from './CloseTerminalDialog';

const RUN_ID = parseRunId('run-terminal-panel');

function CloseDialogHarness({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Show close dialog
      </button>
      <CloseTerminalDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          await onConfirm();
          setOpen(false);
        }}
      />
    </>
  );
}

class FakeTerminalController implements JobTerminalPanelController {
  private snapshotValue: JobTerminalSnapshot = {
    phase: 'available',
    runId: RUN_ID,
    failure: null,
  };
  private readonly listeners = new Set<() => void>();

  readonly open = vi.fn(async () => true);
  readonly close = vi.fn(() => true);
  readonly clear = vi.fn();
  readonly findNext = vi.fn(() => true);
  readonly findPrevious = vi.fn(() => true);
  readonly clearSearch = vi.fn();
  readonly focus = vi.fn();
  readonly setActive = vi.fn();
  readonly setRun = vi.fn();
  readonly handlePageHide = vi.fn();
  readonly dispose = vi.fn();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshotValue;

  setPhase(phase: JobTerminalSnapshot['phase']): void {
    this.snapshotValue = { ...this.snapshotValue, phase };
    for (const listener of this.listeners) listener();
  }

  setFailure(failure: string): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      phase: 'error',
      failure: failure as JobTerminalSnapshot['failure'],
    };
    for (const listener of this.listeners) listener();
  }
}

function createFactory(controller: FakeTerminalController): JobTerminalPanelControllerFactory {
  return vi.fn(() => controller);
}

function renderPanel(options: {
  controller?: FakeTerminalController;
  active?: boolean;
  authorityLoading?: boolean;
  authorityError?: string | null;
  runState?: RunState | null;
  factory?: JobTerminalPanelControllerFactory;
} = {}) {
  const controller = options.controller ?? new FakeTerminalController();
  const factory = options.factory ?? createFactory(controller);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <JobTerminalPanel
        projectId="project-terminal-panel"
        active={options.active ?? true}
        authorityLoading={options.authorityLoading ?? false}
        authorityError={options.authorityError ?? null}
        run={
          options.runState === null
            ? null
            : { id: RUN_ID, state: options.runState ?? 'RUNNING' }
        }
        createController={factory}
      />
    </QueryClientProvider>,
  );
  return { ...view, controller, factory };
}

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('JobTerminalPanel authority and controller matrix', () => {
  it.each([
    { authorityLoading: true, runState: null, expected: 'Loading run authority' },
    { authorityLoading: false, runState: null, expected: 'No active run' },
    { authorityLoading: false, runState: 'STARTING' as const, expected: 'Run starting' },
    { authorityLoading: false, runState: 'STOPPING' as const, expected: 'Run stopping' },
    { authorityLoading: false, runState: 'RECOVERING' as const, expected: 'Run recovering' },
    { authorityLoading: false, runState: 'SUCCEEDED' as const, expected: 'Run succeeded' },
  ])('renders $expected without enabling Open', async ({ authorityLoading, runState, expected }) => {
    renderPanel({ authorityLoading, runState });

    expect(await screen.findByRole('status', { name: 'Terminal state' })).toHaveTextContent(expected);
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  });

  it.each(['available', 'closed', 'exited', 'error'] as const)(
    'enables Open only for a RUNNING authority in the %s phase',
    async (phase) => {
      const controller = new FakeTerminalController();
      const factory = createFactory(controller);
      const { rerender } = renderPanel({ controller, runState: 'RUNNING' });
      await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
      act(() => controller.setPhase(phase));

      expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled();

      rerender(
        <QueryClientProvider client={queryClient}>
          <JobTerminalPanel
            projectId="project-terminal-panel"
            active
            authorityLoading={false}
            authorityError={null}
            run={{ id: RUN_ID, state: 'STOPPING' }}
            createController={factory}
          />
        </QueryClientProvider>,
      );
      expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
    },
  );

  it.each([
    ['creating', false],
    ['connecting', true],
    ['ready', true],
    ['paused', true],
    ['closing', false],
    ['closed', false],
    ['exited', false],
    ['error', false],
  ] as const)('allows Close in %s only when the controller owns a closeable session', async (phase, enabled) => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    act(() => controller.setPhase(phase));

    const close = screen.getByRole('button', { name: 'Close terminal' });
    if (enabled) expect(close).toBeEnabled();
    else expect(close).toBeDisabled();
  });

  it('shows authority failures as alerts and keeps paused state explicit in text', async () => {
    const controller = new FakeTerminalController();
    const factory = createFactory(controller);
    const view = renderPanel({ controller, authorityError: 'Unable to load run authority' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load run authority');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <JobTerminalPanel
          projectId="project-terminal-panel"
          active
          authorityLoading={false}
          authorityError={null}
          run={{ id: RUN_ID, state: 'RUNNING' }}
          createController={factory}
        />
      </QueryClientProvider>,
    );
    act(() => controller.setPhase('paused'));
    expect(screen.getByRole('status', { name: 'Terminal state' })).toHaveTextContent('Input paused');
  });
});

describe('JobTerminalPanel toolbar and views', () => {
  it('keeps Session and Audit mounted while only the selected view is interactive', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    act(() => controller.setPhase('ready'));

    const sessionTab = screen.getByRole('tab', { name: 'Session' });
    const auditTab = screen.getByRole('tab', { name: 'Audit' });
    const session = screen.getByRole('tabpanel', { name: 'Session' });
    const audit = document.getElementById('job-terminal-audit-view');
    expect(audit).not.toBeNull();
    expect(sessionTab).toHaveAttribute('aria-selected', 'true');
    expect(session).not.toHaveAttribute('inert');
    expect(audit).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Clear terminal' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Search terminal' })).toBeEnabled();

    await user.click(auditTab);

    expect(auditTab).toHaveAttribute('aria-selected', 'true');
    expect(session).toHaveAttribute('inert');
    expect(audit).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Clear terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search terminal' })).toBeDisabled();
  });

  it('keeps an inactive panel mounted and inert with every terminal control disabled', async () => {
    const controller = new FakeTerminalController();
    renderPanel({ controller, active: false });
    await waitFor(() => expect(controller.setActive).toHaveBeenCalledWith(false));
    act(() => controller.setPhase('ready'));

    const panel = document.querySelector('[aria-label="Job terminal"]');
    expect(panel).toHaveAttribute('inert');
    expect(screen.getByTestId('job-terminal-viewport')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear terminal', hidden: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search terminal', hidden: true })).toBeDisabled();
  });

  it('forwards pagehide to the current controller and removes the listener on cleanup', async () => {
    const controller = new FakeTerminalController();
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: true }));
    expect(controller.handlePageHide).toHaveBeenNthCalledWith(1, true);

    fireEvent(window, new PageTransitionEvent('pagehide', { persisted: false }));
    expect(controller.handlePageHide).toHaveBeenNthCalledWith(2, false);

    view.unmount();
    const removed = removeListener.mock.calls.find((call) => call[0] === 'pagehide');
    expect(removed).toBeDefined();
    fireEvent(window, new PageTransitionEvent('pagehide'));
    expect(controller.handlePageHide).toHaveBeenCalledTimes(2);
    removeListener.mockRestore();
  });

  it('warns that input overflow closes the session after a possibly sent prefix', async () => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    act(() => controller.setFailure('input-overflow'));

    expect(screen.getByRole('alert', { name: 'Terminal session error' })).toHaveTextContent(
      'Input queue overflow. The session closed; part of the input may already have been sent.',
    );
  });

  it.each([
    [
      'terminal-not-available',
      'The terminal is no longer available. Run authority is being refreshed.',
    ],
    [
      'terminal-session-already-active',
      'A terminal session is already active. The old session must end before an explicit retry.',
    ],
    ['open-failed', 'Terminal session failed. Open a new session to retry.'],
  ] as const)('renders a bounded safe alert for %s', async (failure, message) => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    act(() => controller.setFailure(failure));

    const alert = screen.getByRole('alert', { name: 'Terminal session error' });
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent(/backend|trace/i);
  });
});

describe('JobTerminalPanel viewport and search', () => {
  it('opens against the stable viewport once and disables duplicate Open while pending', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    let resolveOpen: ((value: boolean) => void) | undefined;
    controller.open.mockImplementation(
      () => new Promise<boolean>((resolve) => {
        resolveOpen = resolve;
      }),
    );
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    const open = screen.getByRole('button', { name: 'Open terminal' });
    await user.click(open);

    expect(controller.open).toHaveBeenCalledOnce();
    expect(controller.open).toHaveBeenCalledWith(screen.getByTestId('job-terminal-viewport'));
    expect(open).toBeDisabled();
    fireEvent.click(open);
    expect(controller.open).toHaveBeenCalledOnce();

    await act(async () => resolveOpen?.(true));
    expect(open).toBeEnabled();
  });

  it('keeps authority loading visible inside the full-height viewport', async () => {
    renderPanel({ authorityLoading: true, runState: null });

    const viewport = screen.getByTestId('job-terminal-viewport');
    const state = await screen.findByRole('status', { name: 'Terminal viewport state' });
    expect(state).toHaveTextContent('Loading run authority');
    expect(viewport.parentElement).toContainElement(state);
  });

  it('focuses ready xterm and keeps local search inside the Session viewport', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    act(() => controller.setPhase('ready'));
    await waitFor(() => expect(controller.focus).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Clear terminal' }));
    expect(controller.clear).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Search terminal' }));
    const searchbox = screen.getByRole('searchbox', { name: 'Search terminal output' });
    expect(searchbox.closest('[role="tabpanel"]')).toHaveAttribute(
      'id',
      'job-terminal-session-view',
    );
  });

  it('does not open search shortcuts while the panel is inactive', async () => {
    const controller = new FakeTerminalController();
    renderPanel({ controller, active: false });
    await waitFor(() => expect(controller.setActive).toHaveBeenCalledWith(false));
    act(() => controller.setPhase('ready'));
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    fireEvent(window, shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(screen.queryByRole('searchbox', { hidden: true })).not.toBeInTheDocument();
  });

  it.each([
    ['paused', 'Input paused'],
    ['closing', 'Closing'],
    ['closed', 'Closed'],
    ['exited', 'Exited'],
    ['error', 'Terminal error'],
  ] as const)('keeps scrollback unobscured and reports %s in a compact status surface', async (phase, expected) => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    const viewport = screen.getByTestId('job-terminal-viewport');
    const scrollback = document.createElement('span');
    scrollback.textContent = 'retained scrollback';
    viewport.append(scrollback);

    act(() => controller.setPhase(phase));

    expect(screen.queryByLabelText('Terminal viewport state')).not.toBeInTheDocument();
    expect(viewport).toContainElement(scrollback);
    expect(screen.getByRole('status', { name: 'Terminal state' })).toHaveTextContent(expected);
    if (phase === 'error') {
      expect(screen.getByRole('alert', { name: 'Terminal session error' })).toBeInTheDocument();
    }
  });

  it('announces WebGL and DOM fallback changes without replacing toolbar status slots', async () => {
    const controller = new FakeTerminalController();
    let factoryOptions: JobTerminalPanelControllerFactoryOptions | undefined;
    const factory: JobTerminalPanelControllerFactory = vi.fn((options) => {
      factoryOptions = options;
      return controller;
    });
    renderPanel({ controller, factory });
    await waitFor(() => expect(factoryOptions).toBeDefined());
    const rendererStatus = screen.getByRole('status', { name: 'Terminal renderer' });
    expect(rendererStatus).toHaveTextContent('DOM fallback');

    act(() => factoryOptions?.onRendererChange('webgl'));
    expect(rendererStatus).toHaveTextContent('WebGL');

    act(() => factoryOptions?.onRendererChange('dom'));
    expect(rendererStatus).toHaveTextContent('DOM fallback');
    expect(screen.getByRole('status', { name: 'Terminal state' })).toBeInTheDocument();
  });

  it('invalidates and actively refetches only the current Run authority key', async () => {
    const controller = new FakeTerminalController();
    let factoryOptions: JobTerminalPanelControllerFactoryOptions | undefined;
    const factory: JobTerminalPanelControllerFactory = vi.fn((options) => {
      factoryOptions = options;
      return controller;
    });
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    renderPanel({ controller, factory });
    await waitFor(() => expect(factoryOptions).toBeDefined());

    await act(async () => {
      await factoryOptions?.invalidateRunAuthority('project-terminal-panel');
    });

    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['project-runs', 'project-terminal-panel', 'active'],
      exact: true,
      refetchType: 'active',
    });
  });

  it('resets a new terminal generation to DOM before the new adapter reports a renderer', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    controller.close.mockImplementation(() => {
      controller.setPhase('closed');
      return true;
    });
    let factoryOptions: JobTerminalPanelControllerFactoryOptions | undefined;
    const factory: JobTerminalPanelControllerFactory = vi.fn((options) => {
      factoryOptions = options;
      return controller;
    });
    renderPanel({ controller, factory });
    await waitFor(() => expect(factoryOptions).toBeDefined());
    act(() => controller.setPhase('ready'));
    act(() => factoryOptions?.onRendererChange('webgl'));
    const rendererStatus = screen.getByRole('status', { name: 'Terminal renderer' });
    expect(rendererStatus).toHaveTextContent('WebGL');

    await user.click(screen.getByRole('button', { name: 'Close terminal' }));
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    expect(rendererStatus).toHaveTextContent('WebGL');

    await user.click(screen.getByRole('button', { name: 'Open terminal' }));

    expect(controller.open).toHaveBeenCalledOnce();
    expect(rendererStatus).toHaveTextContent('DOM fallback');
  });
});

describe('JobTerminalPanel audit query integration', () => {
  it('resolves a current Run before the retained last Run during an authority switch', () => {
    const runB = parseRunId('run-terminal-panel-b');

    expect(
      resolveTerminalAuditRunId(
        'project-terminal-panel',
        { id: runB, state: 'RUNNING' },
        { projectId: 'project-terminal-panel', runId: RUN_ID },
      ),
    ).toBe(runB);
  });

  it('renders backend audit pages and loads the opaque next cursor', async () => {
    const user = userEvent.setup();
    const cursors: Array<string | null> = [];
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          cursor === null
            ? {
                items: [{
                  id: 'audit-new',
                  sessionId: 'session-new',
                  command: 'mvn clean test',
                  state: 'SUCCEEDED',
                  startedAt: '2026-08-25T02:00:00.000Z',
                  finishedAt: '2026-08-25T02:00:04.000Z',
                  exitCode: 0,
                }],
                nextCursor: 'cursor-older',
              }
            : {
                items: [{
                  id: 'audit-old',
                  sessionId: 'session-old',
                  command: 'mvn -q test',
                  state: 'FAILED',
                  startedAt: '2026-08-25T01:00:00.000Z',
                  finishedAt: '2026-08-25T01:00:05.000Z',
                  exitCode: 1,
                }],
                nextCursor: null,
              },
        );
      }),
    );
    renderPanel();

    await user.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(await screen.findByText('mvn clean test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more terminal audit' }));
    expect(await screen.findByText('mvn -q test')).toBeInTheDocument();
    expect(cursors).toEqual([null, 'cursor-older']);
  });

  it('keeps the first Audit query DOM and scroll position mounted across Session switches', async () => {
    const user = userEvent.setup();
    let requestCount = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', () => {
        requestCount += 1;
        return HttpResponse.json({
          items: [{
            id: 'audit-mounted',
            sessionId: 'session-mounted',
            command: 'mvn test -Dtest=MountedAudit',
            state: 'SUCCEEDED',
            startedAt: '2026-08-25T02:00:00.000Z',
            finishedAt: '2026-08-25T02:00:04.000Z',
            exitCode: 0,
          }],
          nextCursor: null,
        });
      }),
    );
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Audit' }));
    const command = await screen.findByText('mvn test -Dtest=MountedAudit');
    const table = screen.getByRole('table', { name: 'Terminal command audit' });
    const scroller = table.parentElement;
    expect(scroller).not.toBeNull();
    if (scroller === null) throw new Error('Missing audit scroller');
    scroller.scrollTop = 73;

    await user.click(screen.getByRole('tab', { name: 'Session' }));

    expect(document.querySelector('table')).toBe(table);
    expect(screen.getByText('mvn test -Dtest=MountedAudit')).toBe(command);
    expect(scroller.scrollTop).toBe(73);
    expect(requestCount).toBe(1);

    await user.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(screen.getByRole('table', { name: 'Terminal command audit' })).toBe(table);
    expect(scroller.scrollTop).toBe(73);
    expect(requestCount).toBe(1);
  });

  it('keeps the last session audit available after active authority becomes empty', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', () =>
        HttpResponse.json({
          items: [{
            id: 'audit-last',
            sessionId: 'session-last',
            command: 'mvn test -Dtest=LastSession',
            state: 'INTERRUPTED',
            startedAt: '2026-08-25T02:00:00.000Z',
            finishedAt: '2026-08-25T02:00:03.000Z',
            exitCode: null,
          }],
          nextCursor: null,
        }),
      ),
    );
    const controller = new FakeTerminalController();
    const factory = createFactory(controller);
    const view = renderPanel({ controller, factory });
    await user.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(await screen.findByText('mvn test -Dtest=LastSession')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <JobTerminalPanel
          projectId="project-terminal-panel"
          active
          authorityLoading={false}
          authorityError={null}
          run={null}
          createController={factory}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText('mvn test -Dtest=LastSession')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Audit' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches directly from Run A audit to Run B without retaining Run A content', async () => {
    const user = userEvent.setup();
    const runB = parseRunId('run-terminal-panel-b');
    const requestedRuns: string[] = [];
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', ({ params }) => {
        const requestedRun = String(params.runId);
        requestedRuns.push(requestedRun);
        const isRunB = requestedRun === runB;
        return HttpResponse.json({
          items: [{
            id: isRunB ? 'audit-run-b' : 'audit-run-a',
            sessionId: isRunB ? 'session-run-b' : 'session-run-a',
            command: isRunB ? 'command-from-run-b' : 'command-from-run-a',
            state: 'SUCCEEDED',
            startedAt: '2026-08-25T02:00:00.000Z',
            finishedAt: '2026-08-25T02:00:04.000Z',
            exitCode: 0,
          }],
          nextCursor: null,
        });
      }),
    );
    const controller = new FakeTerminalController();
    const factory = createFactory(controller);
    const view = renderPanel({ controller, factory });
    await user.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(await screen.findByText('command-from-run-a')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <JobTerminalPanel
          projectId="project-terminal-panel"
          active
          authorityLoading={false}
          authorityError={null}
          run={{ id: runB, state: 'RUNNING' }}
          createController={factory}
        />
      </QueryClientProvider>,
    );

    expect(screen.queryByText('command-from-run-a')).not.toBeInTheDocument();
    expect(await screen.findByText('command-from-run-b')).toBeInTheDocument();
    expect(requestedRuns).toEqual([RUN_ID, runB]);
  });
});

describe('CloseTerminalDialog', () => {
  it('explains irreversibility, initially focuses Cancel, and restores focus after Escape', async () => {
    const user = userEvent.setup();
    render(<CloseDialogHarness onConfirm={() => {}} />);
    const trigger = screen.getByRole('button', { name: 'Show close dialog' });

    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Close terminal session' })).toHaveTextContent(
      'cannot be resumed',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('disables every dialog action immediately and ignores duplicate Confirm until completion', async () => {
    const user = userEvent.setup();
    let resolveClose: (() => void) | undefined;
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveClose = resolve;
      }),
    );
    render(<CloseDialogHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Show close dialog' });
    await user.click(trigger);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Close session' });

    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(cancel).toBeDisabled();
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();

    await act(async () => resolveClose?.());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('reports an asynchronous Close failure, re-enables actions, and consumes the rejection', async () => {
    const user = userEvent.setup();
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener('unhandledrejection', unhandled);
    try {
      render(
        <CloseDialogHarness
          onConfirm={() => Promise.reject(new Error('close request failed'))}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Show close dialog' }));
      await user.click(screen.getByRole('button', { name: 'Close session' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Unable to close terminal session',
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Close session' })).toBeEnabled();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', unhandled);
    }
  });

  it('starts a clean dialog cycle after Cancel closes a rejected confirmation', async () => {
    const user = userEvent.setup();
    render(
      <CloseDialogHarness
        onConfirm={() => Promise.reject(new Error('close request failed'))}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Show close dialog' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts a clean dialog cycle after Escape closes a rejected confirmation', async () => {
    const user = userEvent.setup();
    render(
      <CloseDialogHarness
        onConfirm={() => Promise.reject(new Error('close request failed'))}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Show close dialog' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close session' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Cancel' }).focus();

    await user.keyboard('{Escape}');
    await user.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('invalidates an old pending confirmation when the parent closes and reopens', async () => {
    const user = userEvent.setup();
    let rejectClose: ((reason: Error) => void) | undefined;
    const onConfirm = () => new Promise<void>((_resolve, reject) => {
      rejectClose = reject;
    });
    const onCancel = vi.fn();
    const unhandled = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener('unhandledrejection', unhandled);
    try {
      const view = render(
        <CloseTerminalDialog open onConfirm={onConfirm} onCancel={onCancel} />,
      );
      await user.click(screen.getByRole('button', { name: 'Close session' }));
      expect(screen.getByRole('button', { name: 'Close session' })).toBeDisabled();

      view.rerender(
        <CloseTerminalDialog open={false} onConfirm={onConfirm} onCancel={onCancel} />,
      );
      view.rerender(
        <CloseTerminalDialog open onConfirm={onConfirm} onCancel={onCancel} />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Close session' })).toBeEnabled();
      await act(async () => {
        rejectClose?.(new Error('stale close failure'));
        await Promise.resolve();
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', unhandled);
    }
  });

  it('asks for confirmation before forwarding one Close to the controller', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    controller.close.mockImplementation(() => {
      controller.setPhase('closing');
      return true;
    });
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    act(() => controller.setPhase('ready'));
    const closeTrigger = screen.getByRole('button', { name: 'Close terminal' });

    await user.click(closeTrigger);
    expect(controller.close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close session' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(controller.close).toHaveBeenCalledOnce();
    expect(closeTrigger).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Session' })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });
});
