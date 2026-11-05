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
    { authorityLoading: true, runState: null, expected: '正在读取运行状态' },
    { authorityLoading: false, runState: null, expected: '当前没有运行中的任务' },
    { authorityLoading: false, runState: 'STARTING' as const, expected: '运行正在启动' },
    { authorityLoading: false, runState: 'STOPPING' as const, expected: '运行正在停止' },
    { authorityLoading: false, runState: 'RECOVERING' as const, expected: '正在恢复运行状态' },
    { authorityLoading: false, runState: 'SUCCEEDED' as const, expected: '运行成功' },
  ])('renders $expected without enabling Open', async ({ authorityLoading, runState, expected }) => {
    renderPanel({ authorityLoading, runState });

    expect(await screen.findByRole("status", { name: '终端状态' })).toHaveTextContent(expected);
    expect(screen.getByRole('button', { name: '打开终端' })).toBeDisabled();
  });

  it.each(['available', 'closed', 'exited', 'error'] as const)(
    'enables Open only for a RUNNING authority in the %s phase',
    async (phase) => {
      const controller = new FakeTerminalController();
      const factory = createFactory(controller);
      const { rerender } = renderPanel({ controller, runState: 'RUNNING' });
      await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
      act(() => controller.setPhase(phase));

      expect(screen.getByRole('button', { name: '打开终端' })).toBeEnabled();

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
      expect(screen.getByRole('button', { name: '打开终端' })).toBeDisabled();
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

    const close = screen.getByRole('button', { name: '关闭终端' });
    if (enabled) expect(close).toBeEnabled();
    else expect(close).toBeDisabled();
  });

  it('shows authority failures as alerts and keeps paused state explicit in text', async () => {
    const controller = new FakeTerminalController();
    const factory = createFactory(controller);
    const view = renderPanel({ controller, authorityError: "无法读取运行状态" });
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取运行状态');

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
    expect(screen.getByRole("status", { name: '终端状态' })).toHaveTextContent('已暂停输入');
  });
});

describe('JobTerminalPanel toolbar and views', () => {
  it('keeps Session and Audit mounted while only the selected view is interactive', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    act(() => controller.setPhase('ready'));

    const sessionTab = screen.getByRole('tab', { name: '会话' });
    const auditTab = screen.getByRole('tab', { name: '命令记录' });
    const session = screen.getByRole('tabpanel', { name: '会话' });
    const audit = document.getElementById('job-terminal-audit-view');
    expect(audit).not.toBeNull();
    expect(sessionTab).toHaveAttribute('aria-selected', 'true');
    expect(session).not.toHaveAttribute('inert');
    expect(audit).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '清空终端' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '搜索终端' })).toBeEnabled();

    await user.click(auditTab);

    expect(auditTab).toHaveAttribute('aria-selected', 'true');
    expect(session).toHaveAttribute('inert');
    expect(audit).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: '清空终端' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '搜索终端' })).toBeDisabled();
  });

  it('keeps an inactive panel mounted and inert with every terminal control disabled', async () => {
    const controller = new FakeTerminalController();
    renderPanel({ controller, active: false });
    await waitFor(() => expect(controller.setActive).toHaveBeenCalledWith(false));
    act(() => controller.setPhase('ready'));

    const panel = document.querySelector('[aria-label="运行终端"]');
    expect(panel).toHaveAttribute('inert');
    expect(screen.getByTestId('job-terminal-viewport')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清空终端', hidden: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: '搜索终端', hidden: true })).toBeDisabled();
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

    expect(screen.getByRole('alert', { name: '终端会话错误' })).toHaveTextContent(
      '输入队列已满，会话已关闭，部分输入可能已经发送。',
    );
  });

  it.each([
    [
      'terminal-not-available',
      "终端已不可用，正在重新核对运行状态。",
    ],
    [
      'terminal-session-already-active',
      "已有终端会话，请等待原会话结束后再重试。",
    ],
    ['open-failed', "终端会话异常，请打开新会话重试。"],
  ] as const)('renders a bounded safe alert for %s', async (failure, message) => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    act(() => controller.setFailure(failure));

    const alert = screen.getByRole('alert', { name: '终端会话错误' });
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

    const open = screen.getByRole('button', { name: '打开终端' });
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
    const state = await screen.findByRole("status", { name: '终端显示状态' });
    expect(state).toHaveTextContent('正在读取运行状态');
    expect(viewport.parentElement).toContainElement(state);
  });

  it('focuses ready xterm and keeps local search inside the Session viewport', async () => {
    const user = userEvent.setup();
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());

    act(() => controller.setPhase('ready'));
    await waitFor(() => expect(controller.focus).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: '清空终端' }));
    expect(controller.clear).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '搜索终端' }));
    const searchbox = screen.getByRole('searchbox', { name: '搜索终端输出' });
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
    ['paused', "已暂停输入"],
    ['closing', "正在关闭"],
    ['closed', "已关闭"],
    ['exited', "已退出"],
    ['error', "终端异常"],
  ] as const)('keeps scrollback unobscured and reports %s in a compact status surface', async (phase, expected) => {
    const controller = new FakeTerminalController();
    renderPanel({ controller });
    await waitFor(() => expect(controller.setRun).toHaveBeenCalled());
    const viewport = screen.getByTestId('job-terminal-viewport');
    const scrollback = document.createElement('span');
    scrollback.textContent = 'retained scrollback';
    viewport.append(scrollback);

    act(() => controller.setPhase(phase));

    expect(screen.queryByLabelText('终端显示状态')).not.toBeInTheDocument();
    expect(viewport).toContainElement(scrollback);
    expect(screen.getByRole("status", { name: '终端状态' })).toHaveTextContent(expected);
    if (phase === 'error') {
      expect(screen.getByRole('alert', { name: '终端会话错误' })).toBeInTheDocument();
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
    const rendererStatus = screen.getByRole("status", { name: '终端渲染方式' });
    expect(rendererStatus).toHaveTextContent('兼容渲染');

    act(() => factoryOptions?.onRendererChange('webgl'));
    expect(rendererStatus).toHaveTextContent('WebGL');

    act(() => factoryOptions?.onRendererChange('dom'));
    expect(rendererStatus).toHaveTextContent('兼容渲染');
    expect(screen.getByRole("status", { name: '终端状态' })).toBeInTheDocument();
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
    const rendererStatus = screen.getByRole("status", { name: '终端渲染方式' });
    expect(rendererStatus).toHaveTextContent('WebGL');

    await user.click(screen.getByRole('button', { name: '关闭终端' }));
    await user.click(screen.getByRole('button', { name: '关闭会话' }));
    expect(rendererStatus).toHaveTextContent('WebGL');

    await user.click(screen.getByRole('button', { name: '打开终端' }));

    expect(controller.open).toHaveBeenCalledOnce();
    expect(rendererStatus).toHaveTextContent('兼容渲染');
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
                  command: 'mvn -q -DskipTests compile exec:java',
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

    await user.click(screen.getByRole('tab', { name: '命令记录' }));
    expect(await screen.findByText('mvn -q -DskipTests compile exec:java')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '加载更多命令记录' }));
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
    await user.click(screen.getByRole('tab', { name: '命令记录' }));
    const command = await screen.findByText('mvn test -Dtest=MountedAudit');
    const table = screen.getByRole('table', { name: '终端命令记录' });
    const scroller = table.parentElement;
    expect(scroller).not.toBeNull();
    if (scroller === null) throw new Error('Missing audit scroller');
    scroller.scrollTop = 73;

    await user.click(screen.getByRole('tab', { name: '会话' }));

    expect(document.querySelector('table')).toBe(table);
    expect(screen.getByText('mvn test -Dtest=MountedAudit')).toBe(command);
    expect(scroller.scrollTop).toBe(73);
    expect(requestCount).toBe(1);

    await user.click(screen.getByRole('tab', { name: '命令记录' }));
    expect(screen.getByRole('table', { name: '终端命令记录' })).toBe(table);
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
    await user.click(screen.getByRole('tab', { name: '命令记录' }));
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
    expect(screen.getByRole('tab', { name: '命令记录' })).toHaveAttribute('aria-selected', 'true');
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
    await user.click(screen.getByRole('tab', { name: '命令记录' }));
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

    expect(screen.getByRole('dialog', { name: '关闭终端会话' })).toHaveTextContent(
      "关闭后无法恢复",
    );
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();

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
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '关闭会话' });

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
      await user.click(screen.getByRole('button', { name: '关闭会话' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "无法关闭终端会话",
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '关闭会话' })).toBeEnabled();
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
    await user.click(screen.getByRole('button', { name: '关闭会话' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消' }));
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
    await user.click(screen.getByRole('button', { name: '关闭会话' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    screen.getByRole('button', { name: '取消' }).focus();

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
      await user.click(screen.getByRole('button', { name: '关闭会话' }));
      expect(screen.getByRole('button', { name: '关闭会话' })).toBeDisabled();

      view.rerender(
        <CloseTerminalDialog open={false} onConfirm={onConfirm} onCancel={onCancel} />,
      );
      view.rerender(
        <CloseTerminalDialog open onConfirm={onConfirm} onCancel={onCancel} />,
      );

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '关闭会话' })).toBeEnabled();
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
    const closeTrigger = screen.getByRole('button', { name: '关闭终端' });

    await user.click(closeTrigger);
    expect(controller.close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '关闭会话' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(controller.close).toHaveBeenCalledOnce();
    expect(closeTrigger).toBeDisabled();
    expect(screen.getByRole('tab', { name: '会话' })).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });
});
