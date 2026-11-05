import { runStateLabel } from '@/components/ui/labPresentation';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDirectory } from '../../api/fileApi';
import { login } from '../../api/authApi';
import { getRun, startRun, stopRun } from '../../api/runApi';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import { parseWorkspaceRevision } from '../../contracts/file';
import {
  parseRunId,
  parseRunSummary,
  type RunState,
  type RunSummary,
  type RunTerminationReason,
} from '../../contracts/run';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { runPreconditionDescription } from '../../features/editor/runPreconditions';
import { projectAuthorityScope } from '../../features/files/fileMutations';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectDirectoryPath, parseProjectRelativePath } from '../../features/files/pathPolicy';
import { RunLogStore, type NotificationScheduler } from '../../features/logs/RunLogStore';
import * as logProtocol from '../../features/logs/logProtocol';
import { RunLogTransport } from '../../features/logs/RunLogTransport';
import {
  isWorkspaceEditable,
  RunAuthorityCoordinator,
  useRunAuthorityCoordinator,
} from '../../features/runs/RunAuthorityCoordinator';
import type { RuntimeTemplateId } from '../../contracts/project';
import { clonePoc4RunPolicy, clonePythonConsoleRunPolicy, SERVICE_RUN_POLICY, SEED_LOG_MARKER } from '../../mocks/runFixtures';
import { server } from '../../mocks/node';
import { resetLogTickets } from '../../mocks/runSocket';
import { appendLogChunk, setRunScenario, startRun as mockStartRun } from '../../mocks/runState';
import { ALICE_SEED_PROJECT_ID, resetMockState } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import { logDistanceFromBottom, RunLogView } from './RunLogView';
import { RunPanel } from './RunPanel';
import { StopRunDialog } from './StopRunDialog';
import { CloseTerminalDialog } from '../terminal/CloseTerminalDialog';

const ALICE = { username: 'alice', password: 'demo-pass' };
const POLICY = clonePoc4RunPolicy();
const CREATED_AT = '2026-08-24T10:00:00.000Z';
const FINISHED_AT = '2026-08-24T10:00:05.000Z';
const PERSISTED_AT = '2026-08-24T10:00:02.000Z';

async function authenticateAsAlice(): Promise<void> {
  const response = await login(ALICE);
  authSession.authenticate(response);
}

async function workspaceRevision() {
  const tree = await listDirectory(ALICE_SEED_PROJECT_ID, parseProjectDirectoryPath(''));
  return tree.workspaceRevision;
}

async function waitForRunState(runId: RunSummary['id'], pattern: RegExp): Promise<RunSummary> {
  await waitFor(async () => {
    const detail = await getRun(ALICE_SEED_PROJECT_ID, runId);
    expect(detail.state).toMatch(pattern);
  });
  return getRun(ALICE_SEED_PROJECT_ID, runId);
}

function historyRunButton(runId: string): HTMLElement {
  const button = document.querySelector(`[data-run-id="${CSS.escape(runId)}"]`);
  expect(button).toBeInstanceOf(HTMLElement);
  return button as HTMLElement;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function makeRun(
  id: string,
  state: RunState,
  extra: {
    createdAt?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    terminationReason?: RunTerminationReason | null;
    exitCode?: number | null;
    logTruncated?: boolean;
    logEvictedBytes?: number;
    lastLogSeq?: number | null;
    policy?: RunSummary['policy'];
  } = {},
): RunSummary {
  const terminal = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT';
  const terminationReason =
    extra.terminationReason ??
    (state === 'SUCCEEDED'
      ? 'BUILD_SUCCEEDED'
      : state === 'FAILED'
        ? 'BUILD_FAILED'
        : state === 'CANCELLED'
          ? 'USER_STOPPED'
          : state === 'TIMED_OUT'
            ? 'TIME_LIMIT_EXCEEDED'
            : null);
  const exitCode =
    extra.exitCode ?? (state === 'SUCCEEDED' ? 0 : state === 'FAILED' ? 1 : null);
  const createdAt = extra.createdAt ?? CREATED_AT;
  const createdMs = Date.parse(createdAt);
  const startedAt =
    extra.startedAt !== undefined
      ? extra.startedAt
      : state === 'STARTING'
        ? null
        : new Date(createdMs + 1000).toISOString();
  return parseRunSummary({
    id,
    state,
    requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
    policy: extra.policy ?? POLICY,
    createdAt,
    startedAt,
    finishedAt:
      extra.finishedAt !== undefined
        ? extra.finishedAt
        : terminal
          ? new Date(createdMs + 5000).toISOString()
          : null,
    terminationReason,
    exitCode,
    logTruncated: extra.logTruncated ?? false,
    logEvictedBytes: extra.logEvictedBytes ?? 0,
    lastLogSeq: extra.lastLogSeq ?? (terminal ? 1 : null),
  });
}

function stubRuns(options: {
  active?: RunSummary | null;
  history?: RunSummary[];
  nextCursor?: string | null;
}): void {
  const active = options.active === undefined ? null : options.active;
  const history = options.history ?? (active === null ? [] : [active]);
  const nextCursor = options.nextCursor === undefined ? null : options.nextCursor;
  const byId = new Map<string, RunSummary>();
  if (active !== null) {
    byId.set(active.id, active);
  }
  for (const item of history) {
    byId.set(item.id, item);
  }
  server.use(
    http.get('/api/v1/projects/:projectId/runs/active', () => HttpResponse.json({ run: active })),
    http.get('/api/v1/projects/:projectId/runs/:runId', ({ params }) => {
      const runId = String(params.runId);
      if (runId === 'active') {
        return HttpResponse.json({ run: active });
      }
      const run = byId.get(runId);
      if (run === undefined) {
        return HttpResponse.json(
          { code: 'RUN_NOT_FOUND', message: 'Run not found', traceId: 'trace-run-missing' },
          { status: 404 },
        );
      }
      return HttpResponse.json(run);
    }),
    http.get('/api/v1/projects/:projectId/runs', () =>
      HttpResponse.json({ items: history, nextCursor }),
    ),
  );
}

function renderPanel(
  coordinator?: RunAuthorityCoordinator,
  projectTemplateId: RuntimeTemplateId = 'java-console',
  extraProps: { agentTaskActive?: boolean } = {},
) {
  function Harness() {
    const hooked = useRunAuthorityCoordinator(ALICE_SEED_PROJECT_ID);
    return (
      <RunPanel
        projectId={ALICE_SEED_PROJECT_ID}
        coordinator={coordinator ?? hooked}
        projectTemplateId={projectTemplateId}
        {...extraProps}
      />
    );
  }
  return render(
    <AppProviders>
      <Harness />
    </AppProviders>,
  );
}

function renderWithCoordinator(
  coordinator: RunAuthorityCoordinator,
  projectTemplateId: RuntimeTemplateId = 'java-console',
) {
  return render(
    <AppProviders>
      <RunPanel
        projectId={ALICE_SEED_PROJECT_ID}
        coordinator={coordinator}
        projectTemplateId={projectTemplateId}
      />
    </AppProviders>,
  );
}

async function loadedIdle(): Promise<HTMLElement> {
  const start = await screen.findByRole('button', { name: '启动运行' });
  await waitFor(() => {
    expect(start).toBeEnabled();
  });
  return start;
}

function runStateStatus(): HTMLElement {
  return screen.getByRole("status", { name: '运行状态' });
}

function logConnectionStatus(): HTMLElement {
  return screen.getByRole("status", { name: '日志连接状态' });
}

function logRegion(): HTMLElement {
  return screen.getByRole('region', { name: '运行日志' });
}

function documentOrder(earlier: HTMLElement, later: HTMLElement): void {
  expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

function setScrollerMetrics(
  scroller: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
}

function attachScrollModel(scroller: HTMLElement): Array<{ top: number; behavior?: ScrollBehavior }> {
  const calls: Array<{ top: number; behavior?: ScrollBehavior }> = [];
  scroller.scrollTo = ((arg?: ScrollToOptions | number) => {
    if (typeof arg === 'number') {
      scroller.scrollTop = arg;
      calls.push({ top: arg });
      return;
    }
    if (arg !== undefined && typeof arg.top === 'number') {
      scroller.scrollTop = arg.top;
      calls.push({ top: arg.top, behavior: arg.behavior });
    }
  }) as typeof scroller.scrollTo;
  return calls;
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
  vi.restoreAllMocks();
});

describe('RunPanel production boundaries', () => {
  it('injects handleUnauthorized and does not import terminal, xterm, mocks, or logout()', () => {
    const source = readFileSync('src/components/runs/RunPanel.tsx', 'utf8');
    expect(source).toMatch(/onUnauthorized:\s*handleUnauthorized/);
    expect(source).not.toMatch(/\blogout\s*\(/);
    expect(source).not.toMatch(/src\/terminal/);
    expect(source).not.toMatch(/xterm/);
    expect(source).not.toMatch(/src\/mocks/);
    expect(source).not.toMatch(/dangerouslySetInnerHTML/);
    const css = readFileSync('src/styles/globals.css', 'utf8');
    expect(css).toMatch(/run-log-scroller/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe('RunPanel authority and start preconditions', () => {
  it('disables Start while authority is loading and does not treat EDITABLE as unlocked', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/runs/active', async () => {
        await hold;
        return HttpResponse.json({ run: null });
      }),
    );
    await authenticateAsAlice();
    renderPanel();

    const start = await screen.findByRole('button', { name: '启动运行' });
    expect(start).toBeDisabled();
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('AUTHORITY_LOADING'));
    });
    expect(runStateStatus()).toHaveTextContent(/正在核对运行状态/i);
    expect(runStateStatus().querySelector('svg')).not.toBeNull();

    release();
    await loadedIdle();
    expect(start).toHaveAttribute('title', '启动运行');
    expect(runStateStatus()).toHaveTextContent(/空闲/i);
  });

  it('shows an authority error alert with retry and keeps Start disabled', async () => {
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
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/无法读取运行状态/i);
    expect(alert).not.toHaveTextContent('trace-active-403');
    expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();

    await userEvent.setup().click(screen.getByRole('button', { name: '重试读取运行状态' }));
    await loadedIdle();
    expect(attempts).toBeGreaterThan(1);
  });

  it('enables Start when editable and captures revision at click', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/v1/projects/:projectId/runs', async ({ request }) => {
        bodies.push(await request.clone().json());
        return HttpResponse.json(makeRun('run-capture', 'STARTING'), { status: 202 });
      }),
    );
    setRunScenario('disconnect');
    await authenticateAsAlice();
    renderPanel();
    const start = await loadedIdle();
    expect(start.className).toMatch(/h-8/);
    expect(start.className).toMatch(/w-8/);
    expect(screen.getByText('mvn -q -DskipTests compile exec:java')).toBeInTheDocument();
    expect(screen.getByText(/Java 17/)).toBeInTheDocument();
    expect(screen.getByText(/Maven 3/)).toBeInTheDocument();
    expect(screen.getByText(/运行时限 1800 秒/)).toBeInTheDocument();

    const current = queryClient.getQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID));
    expect(typeof current).toBe('string');
    const nextRevision = parseWorkspaceRevision('mock-rev-0099');
    queryClient.setQueryData(fileKeys.revision(ALICE_SEED_PROJECT_ID), nextRevision);

    await userEvent.setup().click(start);
    await waitFor(() => {
      expect(bodies.length).toBeGreaterThan(0);
    });
    expect(bodies[0]).toEqual({ expectedWorkspaceRevision: nextRevision });
    expect(Object.keys(bodies[0] as object)).toEqual(['expectedWorkspaceRevision']);
  });

  it('disables Start while an agent task occupies the workspace', async () => {
    stubRuns({ active: null });
    await authenticateAsAlice();
    renderPanel(undefined, 'java-console', { agentTaskActive: true });
    const start = await screen.findByRole('button', { name: '启动运行' });
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('AGENT_TASK_ACTIVE'));
    });
    expect(start).toBeDisabled();
  });

  it('disables Start for dirty files, write pending, start pending, and active runs', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    workspaceSessionStore.getState().activateProject(ALICE_SEED_PROJECT_ID);
    workspaceSessionStore.getState().setDirty(parseProjectRelativePath('pom.xml'), true);
    renderPanel();
    const start = await screen.findByRole('button', { name: '启动运行' });
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('DIRTY_FILES'));
    });
    expect(start).toBeDisabled();

    workspaceSessionStore.getState().setDirty(parseProjectRelativePath('pom.xml'), false);
    await loadedIdle();

    let releaseWrite = () => {};
    const writeHold = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => writeHold,
      scope: projectAuthorityScope(ALICE_SEED_PROJECT_ID),
    });
    const writePromise = mutation.execute({});
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('WRITE_PENDING'));
    });
    expect(start).toBeDisabled();
    releaseWrite();
    await writePromise.catch(() => {});
    await loadedIdle();

    let releaseStart = () => {};
    const startHold = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    server.use(
      http.post('/api/v1/projects/:projectId/runs', async ({ request, params }) => {
        await startHold;
        const result = mockStartRun(String(params.projectId), await request.json());
        if (!result.ok) {
          return HttpResponse.json(
            { code: result.code, message: result.code, traceId: 'trace-start-hold' },
            { status: 409 },
          );
        }
        return HttpResponse.json(result.value.run, { status: 202 });
      }),
    );
    await userEvent.setup().click(start);
    await waitFor(() => {
      expect(start).toHaveAttribute('title', runPreconditionDescription('START_PENDING'));
    });
    expect(start).toBeDisabled();
    releaseStart();
    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent(/准备运行环境|正在执行/);
    });
    expect(start).toHaveAttribute('title', runPreconditionDescription('RUN_ACTIVE'));
    expect(start).toBeDisabled();
  });
});

describe('RunPanel run policy display', () => {
  it('shows the project template policy before any run exists instead of the Maven default', async () => {
    stubRuns({ active: null, history: [] });
    await authenticateAsAlice();
    renderPanel(undefined, 'python-fastapi-web');
    await loadedIdle();
    expect(screen.getByText('python -u -m uvicorn app.main:app')).toBeInTheDocument();
    expect(screen.getByText(/Python 3\.13 · uv/)).toBeInTheDocument();
    expect(screen.queryByText(/Maven/)).not.toBeInTheDocument();
    expect(screen.queryByText('mvn -q -DskipTests compile exec:java')).not.toBeInTheDocument();
  });

  it('keeps a selected historical run on its own policy without the current template overriding it', async () => {
    const pythonRun = makeRun('run-py-history', 'FAILED', {
      policy: clonePythonConsoleRunPolicy(),
    });
    stubRuns({ active: null, history: [pythonRun] });
    await authenticateAsAlice();
    renderPanel(undefined, 'java-spring-boot-web');
    const user = userEvent.setup();
    const historyButton = await screen.findByRole('button', {
      name: `${pythonRun.createdAt} 运行失败`,
    });
    await user.click(historyButton);
    expect(screen.getByText('python -u main.py')).toBeInTheDocument();
    expect(screen.getByText(/Python 3\.13 · uv/)).toBeInTheDocument();
    expect(screen.queryByText(/Maven/)).not.toBeInTheDocument();
  });
});

describe('RunPanel run states and stop', () => {
  it.each(['RUNNING', 'TIMED_OUT'] as const)('restores Stop from %s authority after Agent occupancy releases', async state => {
    const run = makeRun('run-release', state);
    stubRuns({ active: state === 'RUNNING' ? run : null, history: [run] });
    await authenticateAsAlice();
    const coordinator = new RunAuthorityCoordinator({ projectId: ALICE_SEED_PROJECT_ID, fetchRun: id => getRun(ALICE_SEED_PROJECT_ID, id) });
    const props = { projectId: ALICE_SEED_PROJECT_ID, projectTemplateId: 'java-console' as const, coordinator };
    const view = render(<AppProviders><RunPanel {...props} agentTaskActive /></AppProviders>);
    await waitFor(() => expect(runStateStatus()).toHaveTextContent(runStateLabel(state)));
    expect(screen.getByRole('button', { name: '停止运行' })).toBeDisabled();
    if (state === 'RUNNING') expect(screen.getByRole('button', { name: '停止运行' })).toHaveAttribute('title', 'AI 任务正在管理应用，请先结束任务。');
    view.rerender(<AppProviders><RunPanel {...props} agentTaskActive={false} /></AppProviders>);
    await waitFor(() => {
      if (state === 'RUNNING') expect(screen.getByRole('button', { name: '停止运行' })).toBeEnabled();
      else expect(screen.getByRole('button', { name: '停止运行' })).toBeDisabled();
    });
    expect(screen.queryByText(/AI 任务正在管理应用/)).not.toBeInTheDocument();
  });

  it('keeps start and stop locked during an Agent while retaining logs', async () => {
    stubRuns({ active: makeRun('run-owned', 'RUNNING') });
    await authenticateAsAlice();
    renderPanel(undefined, 'java-console', { agentTaskActive: true });
    await waitFor(() => expect(runStateStatus()).toHaveTextContent('正在执行'));
    expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止运行' })).toBeDisabled();
    expect(screen.getByRole('list', { name: '最近运行' })).toBeInTheDocument();
  });

  it('rechecks Agent occupancy when an already open stop dialog is confirmed', async () => {
    stubRuns({ active: makeRun('run-dialog', 'RUNNING') });
    await authenticateAsAlice();
    const coordinator = new RunAuthorityCoordinator({ projectId: ALICE_SEED_PROJECT_ID, fetchRun: (id) => getRun(ALICE_SEED_PROJECT_ID, id) });
    const stop = vi.fn();
    server.use(http.post('/api/v1/projects/:projectId/runs/active/stop', () => { stop(); return HttpResponse.json({}); }));
    const view = render(<AppProviders><RunPanel projectId={ALICE_SEED_PROJECT_ID} projectTemplateId="java-console" coordinator={coordinator} agentTaskActive={false} /></AppProviders>);
    await waitFor(() => expect(screen.getByRole('button', { name: '停止运行' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('button', { name: '停止运行' }));
    view.rerender(<AppProviders><RunPanel projectId={ALICE_SEED_PROJECT_ID} projectTemplateId="java-console" coordinator={coordinator} agentTaskActive /></AppProviders>);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await userEvent.setup().click(screen.getByRole('button', { name: '停止' }));
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });
  it.each([
    ['STARTING', true, false],
    ['RUNNING', true, false],
    ['STOPPING', false, true],
    ['RECOVERING', false, true],
    ['SUCCEEDED', false, false],
    ['FAILED', false, false],
    ['CANCELLED', false, false],
    ['TIMED_OUT', false, false],
  ] as const)('shows %s with Stop enabled=%s waiting=%s', async (state, stopEnabled, waiting) => {
    const run = makeRun(`run-${state.toLowerCase()}`, state);
    stubRuns({
      active: state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT' ? null : run,
      history: [run],
    });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent(runStateLabel(state));
    });
    expect(runStateStatus().querySelector('svg')).not.toBeNull();
    expect(screen.getByText('mvn -q -DskipTests compile exec:java')).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: '停止运行' });
    if (stopEnabled) {
      expect(stop).toBeEnabled();
    } else {
      expect(stop).toBeDisabled();
    }
    if (waiting) {
      expect(runStateStatus()).toHaveTextContent(/等待服务端确认/i);
      expect(stop.getAttribute('title')).toMatch(/等待服务端确认/i);
    }
    if (state === 'TIMED_OUT') {
      expect(runStateStatus()).toHaveTextContent('运行超时');
      expect(screen.getByText(/结束于/)).toHaveTextContent(FINISHED_AT);
    }
    if (state === 'STARTING' || state === 'RUNNING' || state === 'STOPPING' || state === 'RECOVERING') {
      expect(screen.getByText(/已运行/)).toBeInTheDocument();
    }
  });

  it('keeps a live elapsed timer display-only without marking TIMED_OUT', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    renderPanel();
    await loadedIdle();
    await userEvent.setup().click(screen.getByRole('button', { name: '启动运行' }));
    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('正在执行');
    });
    expect(screen.getByText(/已运行/)).toBeInTheDocument();
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    expect(runStateStatus()).toHaveTextContent('正在执行');
    expect(runStateStatus()).not.toHaveTextContent('运行超时');
    expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();
    expect(isWorkspaceEditable).toBeTypeOf('function');
  });

  it('opens Stop confirmation with Cancel focused, Escape cancels, and confirm stops', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    renderPanel();
    await loadedIdle();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '启动运行' }));
    const stop = await screen.findByRole('button', { name: '停止运行' });
    await waitFor(() => {
      expect(stop).toBeEnabled();
    });

    await user.click(stop);
    expect(await screen.findByRole('dialog', { name: '停止运行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '停止运行' })).not.toBeInTheDocument();
    });
    expect(stop).toHaveFocus();
    expect(runStateStatus()).toHaveTextContent(/准备运行环境|正在执行/);

    await user.click(stop);
    expect(await screen.findByRole('dialog', { name: '停止运行' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(runStateStatus()).toHaveTextContent(/准备运行环境|正在执行/);

    await user.click(stop);
    await user.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent(/正在停止|已停止|正在重新加载工作区/);
    });
  });
});

describe('RunPanel service lifetime display', () => {
  function makeServiceRun(
    id: string,
    state: RunState,
    extra: {
      createdAt?: string;
      startedAt?: string | null;
      finishedAt?: string | null;
      terminationReason?: RunTerminationReason | null;
      firstReadyAt?: string | null;
      expiresAt?: string | null;
    } = {},
  ): RunSummary {
    const terminal =
      state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT';
    const createdAt = extra.createdAt ?? new Date(Date.now() - 3 * 3600_000).toISOString();
    const createdMs = Date.parse(createdAt);
    const startedAt =
      extra.startedAt !== undefined
        ? extra.startedAt
        : state === 'STARTING'
          ? null
          : new Date(createdMs + 60_000).toISOString();
    const firstReadyAt = extra.firstReadyAt ?? null;
    const expiresAt = extra.expiresAt ?? null;
    return parseRunSummary({
      id,
      state,
      requestedWorkspaceRevision: parseWorkspaceRevision('mock-rev-0001'),
      policy: SERVICE_RUN_POLICY,
      createdAt,
      startedAt,
      finishedAt:
        extra.finishedAt !== undefined ? extra.finishedAt : terminal ? startedAt : null,
      terminationReason:
        extra.terminationReason ??
        (state === 'FAILED'
          ? 'APPLICATION_EXITED'
          : state === 'CANCELLED'
            ? 'USER_STOPPED'
            : state === 'TIMED_OUT'
              ? 'TIME_LIMIT_EXCEEDED'
              : null),
      exitCode: state === 'FAILED' ? 1 : state === 'SUCCEEDED' ? 0 : null,
      logTruncated: false,
      logEvictedBytes: 0,
      lastLogSeq: terminal ? 1 : null,
      firstReadyAt,
      expiresAt,
    });
  }

  function availabilityStatus(): HTMLElement {
    return screen.getByRole("status", { name: '服务可用状态' });
  }

  it('shows Starting before verified readiness and does not count the lifetime yet', async () => {
    stubRuns({ active: makeServiceRun('run-svc-starting', 'RUNNING') });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('正在执行');
    });
    expect(availabilityStatus()).toHaveTextContent('正在启动');
    expect(availabilityStatus()).not.toHaveTextContent(/剩余/);
    expect(screen.getByText(/已运行/)).toBeInTheDocument();
  });

  it('shows Accessible with the remaining verified lifetime', async () => {
    const nowMs = Date.now();
    stubRuns({
      active: makeServiceRun('run-svc-ready', 'RUNNING', {
        firstReadyAt: new Date(nowMs - 7100_000).toISOString(),
        expiresAt: new Date(nowMs + 100_000).toISOString(),
      }),
    });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(availabilityStatus()).toHaveTextContent(/可访问/);
    });
    expect(availabilityStatus()).toHaveTextContent(/剩余/);
  });

  it('shows Unavailable after the lifetime ends without inventing a terminal state', async () => {
    const nowMs = Date.now();
    stubRuns({
      active: makeServiceRun('run-svc-expired', 'RUNNING', {
        firstReadyAt: new Date(nowMs - 7201_000).toISOString(),
        expiresAt: new Date(nowMs - 1000).toISOString(),
      }),
    });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(availabilityStatus()).toHaveTextContent('暂不可用');
    });
    expect(runStateStatus()).toHaveTextContent('正在执行');
    expect(runStateStatus()).not.toHaveTextContent('运行超时');
    expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();
  });

  it('marks a service run that reached the two hour limit', async () => {
    const nowMs = Date.now();
    stubRuns({
      active: null,
      history: [
        makeServiceRun('run-svc-limit', 'TIMED_OUT', {
          createdAt: new Date(nowMs - 3 * 3600_000).toISOString(),
          startedAt: new Date(nowMs - 2 * 3600_000 - 60_000).toISOString(),
          finishedAt: new Date(nowMs - 1000).toISOString(),
          terminationReason: 'TIME_LIMIT_EXCEEDED',
          firstReadyAt: new Date(nowMs - 7200_000).toISOString(),
          expiresAt: new Date(nowMs).toISOString(),
        }),
      ],
    });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('运行超时');
    });
    expect(availabilityStatus()).toHaveTextContent('已达到两小时运行上限');
  });

  it('shows Failed and Stopped for exited and user-stopped service runs', async () => {
    stubRuns({
      active: null,
      history: [
        makeServiceRun('run-svc-exited', 'FAILED', {
          finishedAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ],
    });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('运行失败');
    });
    expect(availabilityStatus()).toHaveTextContent('失败');

    cleanup();
    resetAppRuntime();
    await authenticateAsAlice();
    stubRuns({
      active: null,
      history: [
        makeServiceRun('run-svc-stopped', 'CANCELLED', {
          finishedAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('已停止');
    });
    expect(availabilityStatus()).toHaveTextContent('已停止');
  });

  it('shows no availability status for TASK runs', async () => {
    stubRuns({ active: makeRun('run-task', 'RUNNING') });
    await authenticateAsAlice();
    renderPanel();

    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent('正在执行');
    });
    expect(screen.queryByRole("status", { name: '服务可用状态' })).toBeNull();
  });

  it('surfaces the dependency-not-ready hint from a rejected start', async () => {
    server.use(
      http.post('/api/v1/projects/:projectId/runs', () =>
        HttpResponse.json(
          {
            code: 'DEPENDENCY_NOT_READY',
            message: 'Selected dependencies are not ready yet. Try again once they are ready.',
            traceId: 'trace-deps-not-ready',
          },
          { status: 409 },
        ),
      ),
    );
    await authenticateAsAlice();
    renderPanel();
    const start = await loadedIdle();
    await userEvent.setup().click(start);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Selected dependencies are not ready yet. Try again once they are ready.',
    );
  });
});

describe('RunPanel history', () => {
  it('consumes Run selection once per seq and preserves subsequent manual history selection', async () => {
    const first = makeRun('run-first', 'SUCCEEDED');
    const second = makeRun('run-second', 'FAILED', { createdAt: '2026-08-24T09:00:00.000Z' });
    stubRuns({ history: [first, second] });
    await authenticateAsAlice();
    const coordinator = new RunAuthorityCoordinator({ projectId: ALICE_SEED_PROJECT_ID, fetchRun: (id) => getRun(ALICE_SEED_PROJECT_ID, id) });
    const panel = (seq: number) => <AppProviders><RunPanel projectId={ALICE_SEED_PROJECT_ID} projectTemplateId="java-console" coordinator={coordinator} requestRunSelection={{ runId: second.id, seq }} /></AppProviders>;
    const view = render(panel(1));
    await waitFor(() => expect(historyRunButton(second.id)).toHaveAttribute('aria-current', 'true'));
    await userEvent.setup().click(historyRunButton(first.id));
    view.rerender(panel(1));
    expect(historyRunButton(first.id)).toHaveAttribute('aria-current', 'true');
    view.rerender(panel(2));
    await waitFor(() => expect(historyRunButton(second.id)).toHaveAttribute('aria-current', 'true'));
  });
  it('renders empty, loading, error, and cursor paging', async () => {
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/v1/projects/:projectId/runs', async () => {
        await hold;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    await authenticateAsAlice();
    renderPanel();
    expect(await screen.findByRole("status", { name: '正在加载运行历史' })).toBeInTheDocument();
    release();
    expect(await screen.findByText('暂无运行记录')).toBeInTheDocument();
    cleanup();
    resetAppRuntime();
    await authenticateAsAlice();

    let lists = 0;
    server.use(
      http.get('/api/v1/projects/:projectId/runs', () => {
        lists += 1;
        if (lists === 1) {
          return HttpResponse.json(
            { code: 'FORBIDDEN', message: 'Access denied', traceId: 'trace-history-403' },
            { status: 403 },
          );
        }
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderPanel();
    const historyAlert = await screen.findByText('无法加载运行历史');
    expect(historyAlert).toHaveAttribute('role', 'alert');
    expect(historyAlert).not.toHaveTextContent('trace-history-403');
    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载运行历史' }));
    expect(await screen.findByText('暂无运行记录')).toBeInTheDocument();
    cleanup();
    resetAppRuntime();
    await authenticateAsAlice();

    const first = makeRun('run-new', 'SUCCEEDED', { createdAt: '2026-08-24T11:00:00.000Z' });
    const second = makeRun('run-old', 'FAILED', { createdAt: '2026-08-24T10:00:00.000Z' });
    server.use(
      http.get('/api/v1/projects/:projectId/runs', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === null) {
          return HttpResponse.json({ items: [first], nextCursor: 'opaque-cursor-2' });
        }
        expect(cursor).toBe('opaque-cursor-2');
        return HttpResponse.json({ items: [second], nextCursor: null });
      }),
    );
    renderPanel();
    const history = await screen.findByRole('list', { name: '最近运行' });
    expect(within(history).getByRole('button', { name: `${first.createdAt} 运行成功` })).toBeInTheDocument();
    const loadMore = screen.getByRole('button', { name: '加载更多' });
    await userEvent.setup().click(loadMore);
    expect(
      await within(history).findByRole('button', { name: `${second.createdAt} 运行失败` }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    });
  });

  it('auto-selects active and new runs unless the user picked history', async () => {
    await authenticateAsAlice();
    setRunScenario('success');
    const historical = await startRun(ALICE_SEED_PROJECT_ID, {
      expectedWorkspaceRevision: await workspaceRevision(),
    });
    const finished = await waitForRunState(historical.id, /SUCCEEDED|FAILED|CANCELLED|TIMED_OUT/);
    setRunScenario('disconnect');

    renderPanel();
    const historyButton = await screen.findByRole('button', {
      name: `${finished.createdAt} ${runStateLabel(finished.state)}`,
    });
    expect(historyButton).toHaveAttribute('aria-current', 'true');
    const user = userEvent.setup();
    await user.click(historyButton);
    await loadedIdle();
    await user.click(screen.getByRole('button', { name: '启动运行' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();
    });
    expect(historyRunButton(finished.id)).toHaveAttribute('aria-current', 'true');
    expect(runStateStatus()).toHaveTextContent(runStateLabel(finished.state));

    cleanup();
    resetAppRuntime();
    resetMockState();
    resetLogTickets();
    await authenticateAsAlice();
    setRunScenario('disconnect');
    renderPanel();
    await loadedIdle();
    await userEvent.setup().click(screen.getByRole('button', { name: '启动运行' }));
    await waitFor(() => {
      expect(runStateStatus()).toHaveTextContent(/准备运行环境|正在执行/);
    });
    expect(runStateStatus()).not.toHaveTextContent(runStateLabel(finished.state));
  });
});

describe('RunPanel logs', () => {
  it('streams selected run logs, isolates history switches, and disposes the previous transport', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    const revision = await workspaceRevision();
    const first = await startRun(ALICE_SEED_PROJECT_ID, { expectedWorkspaceRevision: revision });
    await waitForRunState(first.id, /RUNNING/);
    expect(appendLogChunk(ALICE_SEED_PROJECT_ID, first.id, 'alpha-only\n').ok).toBe(true);
    const firstCursor = (await getRun(ALICE_SEED_PROJECT_ID, first.id)).lastLogSeq;
    expect(firstCursor).toEqual(expect.any(Number));
    await stopRun(ALICE_SEED_PROJECT_ID, first.id);
    await waitForRunState(first.id, /CANCELLED/);
    const second = await startRun(ALICE_SEED_PROJECT_ID, { expectedWorkspaceRevision: revision });
    await waitForRunState(second.id, /RUNNING/);
    expect(appendLogChunk(ALICE_SEED_PROJECT_ID, second.id, 'beta-only\n').ok).toBe(true);

    const subscribe = vi.spyOn(logProtocol, 'encodeLogSubscribe');
    const live = new Set<RunLogTransport>();
    const origConnect = RunLogTransport.prototype.connect;
    const origDispose = RunLogTransport.prototype.dispose;
    vi.spyOn(RunLogTransport.prototype, 'connect').mockImplementation(function (this: RunLogTransport) {
      live.add(this);
      return origConnect.call(this);
    });
    const dispose = vi.spyOn(RunLogTransport.prototype, 'dispose').mockImplementation(function (this: RunLogTransport) {
      live.delete(this);
      return origDispose.call(this);
    });
    renderPanel();
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent('beta-only');
    });
    expect(logRegion()).not.toHaveTextContent('alpha-only');
    expect(live.size).toBe(1);
    const disposedAfterMount = dispose.mock.calls.length;

    await userEvent.setup().click(historyRunButton(first.id));
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent('alpha-only');
    });
    expect(logRegion()).not.toHaveTextContent('beta-only');
    expect(dispose.mock.calls.length).toBeGreaterThan(disposedAfterMount);
    expect(live.size).toBe(1);
    const alphaCopies = (logRegion().textContent ?? '').split('alpha-only').length - 1;
    expect(alphaCopies).toBe(1);

    await userEvent.setup().click(historyRunButton(second.id));
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent('beta-only');
    });
    expect(logRegion()).not.toHaveTextContent('alpha-only');
    expect(live.size).toBe(1);
    const callsBeforeReturn = subscribe.mock.calls.length;

    await userEvent.setup().click(historyRunButton(first.id));
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent('alpha-only');
    });
    expect(logRegion()).not.toHaveTextContent('beta-only');
    expect(live.size).toBe(1);
    expect((logRegion().textContent ?? '').split('alpha-only').length - 1).toBe(1);
    expect(subscribe.mock.calls[callsBeforeReturn]?.[0]).toBe(firstCursor);
  });

  it('announces connection changes and errors without live-region log chunks', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    renderPanel();
    await loadedIdle();
    await userEvent.setup().click(screen.getByRole('button', { name: '启动运行' }));
    await waitFor(() => {
      expect(logConnectionStatus()).toHaveTextContent(/实时更新中|正在读取历史日志|正在重新连接|正在连接|正在获取日志访问权限/i);
    });
    expect(logConnectionStatus()).toHaveAttribute('role', 'status');
    expect(logRegion().getAttribute('aria-live')).toBeNull();
    expect(logRegion().closest('[aria-live]')).toBeNull();
    const before = logConnectionStatus().textContent;
    const runId = document.querySelector('[data-run-id]')?.getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    expect(appendLogChunk(ALICE_SEED_PROJECT_ID, runId!, 'chunk-should-not-announce\n').ok).toBe(true);
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent('chunk-should-not-announce');
    });
    expect(logConnectionStatus().textContent).toBe(before);
  });
});

describe('RunPanel reload failure and keyboard', () => {
  it('shows reload failure as an alert and keeps Start disabled', async () => {
    const locking = makeRun('run-reload', 'RUNNING');
    const terminal = makeRun('run-reload', 'SUCCEEDED');
    const coordinator = new RunAuthorityCoordinator({
      projectId: ALICE_SEED_PROJECT_ID,
      fetchRun: async () => terminal,
    });
    stubRuns({ active: locking, history: [locking] });
    await authenticateAsAlice();
    renderWithCoordinator(coordinator);
    await waitFor(() => {
      expect(coordinator.getSnapshot().observedLockingRunId).toBe(locking.id);
    });
    stubRuns({ active: null, history: [terminal] });
    await queryClient.invalidateQueries();
    await waitFor(() => {
      expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    });
    coordinator.markReloadFailed();
    expect((await screen.findByRole('button', { name: '重试加载工作区' })).parentElement).toHaveTextContent('工作区重新加载失败');
    expect(screen.getByRole('button', { name: '重试加载工作区' }).parentElement?.querySelector('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '启动运行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '启动运行' })).toHaveAttribute(
      'title',
      runPreconditionDescription('RELOAD_FAILED'),
    );
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);

    await userEvent.setup().click(screen.getByRole('button', { name: '重试加载工作区' }));
    expect(coordinator.getSnapshot().phase).toBe('RELOADING_WORKSPACE');
    expect(isWorkspaceEditable(coordinator.getSnapshot())).toBe(false);
  });

  it('uses toolbar -> history -> logs -> New output tab order', async () => {
    setRunScenario('disconnect');
    await authenticateAsAlice();
    renderPanel();
    const start = await loadedIdle();
    const user = userEvent.setup();
    await user.click(start);
    await waitFor(() => {
      expect(logRegion()).toHaveTextContent(SEED_LOG_MARKER);
    });
    const stop = screen.getByRole('button', { name: '停止运行' });
    const historyButton = await screen.findByRole('button', { name: /正在执行|准备运行环境/ });
    const logs = logRegion();
    setScrollerMetrics(logs, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    fireScroll(logs);
    const newOutput = await screen.findByRole('button', { name: '查看最新输出' });
    documentOrder(start, stop);
    documentOrder(stop, historyButton);
    documentOrder(historyButton, logs);
    documentOrder(logs, newOutput);
  });
});

describe('RunLogView auto-follow and truncation', () => {
  function appendText(
    store: RunLogStore,
    scheduler: { flush: () => void },
    seq: number,
    text: string,
    extra: { truncated?: boolean; evictedBytes?: number } = {},
  ): void {
    const item = {
      seq,
      text,
      byteLength: utf8Bytes(text),
      persistedAt: PERSISTED_AT,
    };
    store.applyAppend(item, {
      firstAvailableSeq: extra.truncated === true ? seq : 1,
      lastAvailableSeq: seq,
      retainedBytes: item.byteLength,
      truncated: extra.truncated === true,
      evictedBytes: extra.evictedBytes ?? 0,
    });
    act(() => {
      scheduler.flush();
    });
  }

  it('does not force scrollTop to the bottom after a real scroll-up', async () => {
    const scheduler = manualScheduler();
    const store = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId: parseRunId('run-follow'),
      schedule: scheduler.schedule,
    });
    appendText(store, scheduler, 1, 'line-one\n');
    render(<RunLogView store={store} />);
    const scroller = screen.getByRole('region', { name: '运行日志' });
    setScrollerMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    const calls = attachScrollModel(scroller);
    expect(logDistanceFromBottom(scroller)).toBeGreaterThan(48);
    fireScroll(scroller);
    act(() => {
      scheduler.flush();
    });
    expect(await screen.findByRole('button', { name: '查看最新输出' })).toBeInTheDocument();
    expect(store.getSnapshot().pendingOutput).toBe(true);
    const callsAfterScroll = calls.length;
    const topAfterScroll = scroller.scrollTop;

    appendText(store, scheduler, 2, 'line-two\n');
    expect(scroller.scrollTop).toBe(topAfterScroll);
    expect(scroller.scrollTop).not.toBe(scroller.scrollHeight);
    expect(calls.length).toBe(callsAfterScroll);
    expect(screen.getByRole('region', { name: '运行日志' })).toHaveTextContent('line-two');

    await userEvent.setup().click(screen.getByRole('button', { name: '查看最新输出' }));
    act(() => {
      scheduler.flush();
    });
    expect(store.getSnapshot().pendingOutput).toBe(false);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(screen.queryByRole('button', { name: '查看最新输出' })).not.toBeInTheDocument();
  });

  it('keeps following from near the bottom with instant scroll', () => {
    const scheduler = manualScheduler();
    const store = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId: parseRunId('run-follow-bottom'),
      schedule: scheduler.schedule,
    });
    appendText(store, scheduler, 1, 'line-one\n');
    render(<RunLogView store={store} />);
    const scroller = screen.getByRole('region', { name: '运行日志' });
    setScrollerMetrics(scroller, { scrollTop: 360, clientHeight: 100, scrollHeight: 400 });
    const calls = attachScrollModel(scroller);
    expect(logDistanceFromBottom(scroller)).toBeLessThanOrEqual(48);
    fireScroll(scroller);
    act(() => {
      scheduler.flush();
    });
    expect(store.getSnapshot().pendingOutput).toBe(false);

    appendText(store, scheduler, 2, 'line-two\n');
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.behavior !== 'smooth')).toBe(true);
    expect(screen.queryByRole('button', { name: '查看最新输出' })).not.toBeInTheDocument();
  });

  it('resets follow when the selected run store changes', () => {
    const schedulerA = manualScheduler();
    const schedulerB = manualScheduler();
    const storeA = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId: parseRunId('run-a'),
      schedule: schedulerA.schedule,
    });
    const storeB = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId: parseRunId('run-b'),
      schedule: schedulerB.schedule,
    });
    appendText(storeA, schedulerA, 1, 'alpha-one\n');
    appendText(storeB, schedulerB, 1, 'beta-one\n');
    const { rerender } = render(<RunLogView store={storeA} />);
    const scroller = screen.getByRole('region', { name: '运行日志' });
    setScrollerMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    attachScrollModel(scroller);
    fireScroll(scroller);
    act(() => {
      schedulerA.flush();
    });
    expect(storeA.getSnapshot().pendingOutput).toBe(true);
    appendText(storeA, schedulerA, 2, 'alpha-two\n');
    expect(scroller.scrollTop).toBe(0);

    rerender(<RunLogView store={storeB} />);
    const next = screen.getByRole('region', { name: '运行日志' });
    setScrollerMetrics(next, { scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    attachScrollModel(next);
    appendText(storeB, schedulerB, 2, 'beta-two\n');
    expect(next.scrollTop).toBe(next.scrollHeight);
    expect(screen.getByRole('region', { name: '运行日志' })).toHaveTextContent('beta-two');
    expect(screen.getByRole('region', { name: '运行日志' })).not.toHaveTextContent('alpha-two');
    expect(screen.queryByRole('button', { name: '查看最新输出' })).not.toBeInTheDocument();
  });

  it('keeps truncation and evicted bytes visible without covering log text', () => {
    const runId = parseRunId('run-trunc');
    const store = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      schedule: (notify) => {
        notify();
        return () => {};
      },
    });
    const chunk = {
      seq: 4,
      text: 'kept-window\n',
      byteLength: utf8Bytes('kept-window\n'),
      persistedAt: PERSISTED_AT,
    };
    store.applyAppend(chunk, {
      firstAvailableSeq: 4,
      lastAvailableSeq: 4,
      retainedBytes: chunk.byteLength,
      truncated: true,
      evictedBytes: 2048,
    });
    render(<RunLogView store={store} />);
    const banner = screen.getByRole("status", { name: '日志截断提示' });
    expect(banner).toHaveTextContent('日志窗口已截断');
    expect(banner).toHaveTextContent('2048');
    expect(screen.getByRole('region', { name: '运行日志' })).toHaveTextContent('kept-window');
    expect(banner.compareDocumentPosition(logRegion()) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('disables smooth scrolling when prefers-reduced-motion is reduce', () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      })) as typeof window.matchMedia;
    const scheduler = manualScheduler();
    const store = new RunLogStore({
      projectId: ALICE_SEED_PROJECT_ID,
      runId: parseRunId('run-motion'),
      schedule: scheduler.schedule,
    });
    appendText(store, scheduler, 1, 'motion\n');
    render(<RunLogView store={store} />);
    const scroller = screen.getByRole('region', { name: '运行日志' });
    setScrollerMetrics(scroller, { scrollTop: 360, clientHeight: 100, scrollHeight: 400 });
    const calls = attachScrollModel(scroller);
    fireScroll(scroller);
    appendText(store, scheduler, 2, 'more\n');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.behavior !== 'smooth')).toBe(true);
    expect(calls.every((call) => call.behavior === 'auto' || call.behavior === undefined)).toBe(true);
  });
});

describe('StopRunDialog', () => {
  it('focuses Cancel, traps Tab, treats Escape as Cancel, and restores the trigger', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = 'Stop run';
    document.body.append(trigger);
    trigger.focus();

    const { rerender } = render(
      <StopRunDialog open onCancel={onCancel} onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '停止' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(<StopRunDialog open={false} onCancel={onCancel} onConfirm={onConfirm} />);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe('Run dialog copy', () => {
  it('asks about the run generically without naming Maven', () => {
    render(<StopRunDialog open onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const message = screen.getByText(/运行状态将以服务端确认结果为准/);
    expect(message).toHaveTextContent(
      '确认停止当前运行？运行状态将以服务端确认结果为准。',
    );
    expect(message).not.toHaveTextContent(/Maven/i);
  });

  it('keeps the terminal close dialog on a generic run message', () => {
    render(<CloseTerminalDialog open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const message = screen.getByText(/项目运行将继续/);
    expect(message).toHaveTextContent(
      '此终端会话关闭后无法恢复，项目运行将继续。',
    );
    expect(message).not.toHaveTextContent(/Maven/i);
  });
});

function fireScroll(scroller: HTMLElement): void {
  scroller.dispatchEvent(new Event('scroll'));
}

function manualScheduler(): { schedule: NotificationScheduler; flush: () => void } {
  let pending: (() => void) | null = null;
  return {
    schedule(notify) {
      pending = notify;
      return () => {
        if (pending === notify) {
          pending = null;
        }
      };
    },
    flush() {
      const notify = pending;
      pending = null;
      notify?.();
    },
  };
}
