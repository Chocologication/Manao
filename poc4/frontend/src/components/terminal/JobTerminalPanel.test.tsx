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
});

describe('JobTerminalPanel audit query integration', () => {
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

  it('asks for confirmation before forwarding one Close to the controller', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
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
    expect(closeTrigger).toHaveFocus();
  });
});
