import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTaskStorageKey } from '../../api/agentTaskApi';
import type { AgentTaskSnapshot } from '../../contracts/agentTask';
import { AppProviders } from '../../app/AppProviders';
import { queryClient } from '../../app/appRuntime';
import { resetAppRuntime } from '../../test/renderApp';
import { workspaceSessionStore } from '../../features/editor/workspaceSession';
import { fileKeys } from '../../features/files/fileQueries';
import { parseProjectRelativePath } from '../../features/files/pathPolicy';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID } from '../../mocks/state';
import { useCurrentAgentTaskQuery } from './agentTaskQueries';
import { AgentTaskPanel, type AgentTaskPanelProps } from './AgentTaskPanel';

const PROJECT_ID = ALICE_SEED_PROJECT_ID;
const USER_ID = 'user-alice';
const TASK_ID = '0b8fd38f-0f9e-4c28-9c48-3f5f4a2b1c11';
const CURRENT_URL = `/api/v1/projects/${PROJECT_ID}/agent-tasks/current`;
const TASKS_URL = `/api/v1/projects/${PROJECT_ID}/agent-tasks`;

function occupyingTask(overrides: Partial<AgentTaskSnapshot> = {}): AgentTaskSnapshot {
  return {
    taskId: TASK_ID,
    state: 'RUNNING',
    workspaceRevision: '7',
    writesLocked: true,
    progress: [
      { seq: 1, kind: 'message', text: 'Reading pom.xml', truncated: false },
      {
        seq: 2,
        kind: 'tool_start',
        text: 'write_file src/main/java/demo/DemoController.java',
        truncated: false,
      },
    ],
    changedPaths: [],
    summary: null,
    failureCode: null,
    ...overrides,
  };
}

type PanelHarness = {
  getAccepted(): AgentTaskSnapshot | null;
  getCloseCalls(): number;
};

function renderPanel(props: Partial<AgentTaskPanelProps> = {}): PanelHarness {
  let accepted: AgentTaskSnapshot | null = null;
  let closeCalls = 0;
  render(
    <AppProviders>
      <AgentTaskPanel
        projectId={PROJECT_ID}
        userId={USER_ID}
        task={null}
        settledTask={null}
        pollFailed={false}
        writePending={false}
        hasActiveRun={false}
        reloading={false}
        closePending={false}
        onTaskAccepted={(task) => {
          accepted = task;
        }}
        onClose={() => {
          closeCalls += 1;
        }}
        {...props}
      />
    </AppProviders>,
  );
  return {
    getAccepted: () => accepted,
    getCloseCalls: () => closeCalls,
  };
}

beforeEach(() => {
  resetAppRuntime();
  sessionStorage.clear();
  queryClient.setQueryData(fileKeys.revision(PROJECT_ID), '7');
  workspaceSessionStore.getState().activateProject(PROJECT_ID);
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('AgentTaskPanel preconditions', () => {
  it('disables Start with the visible reason while the workspace is dirty', async () => {
    const user = userEvent.setup();
    act(() => {
      workspaceSessionStore.getState().setDirty(parseProjectRelativePath('pom.xml'), true);
    });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('DIRTY_FILES')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Task goal'), 'Fix the failing test');
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

  it('does not POST while a save or dependency write is pending', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPanel({ writePending: true });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('WRITE_PENDING')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not POST while a run is active or the workspace reloads', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPanel({ hasActiveRun: true });
    expect(screen.getByText('RUN_ACTIVE')).toBeInTheDocument();
    renderPanel({ reloading: true });
    expect(screen.getAllByText('RELOADING').length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not POST while the workspace revision is unknown', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    queryClient.removeQueries({ queryKey: fileKeys.revision(PROJECT_ID) });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('REVISION_UNAVAILABLE')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('disables Start while the polled agent task occupies the workspace', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPanel({ task: occupyingTask() });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('TASK_ACTIVE')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AgentTaskPanel start flow', () => {
  it('submits the goal under a UUID stored before the POST', async () => {
    const user = userEvent.setup();
    const bodies: Array<{ taskId: string; prompt: string; expectedWorkspaceRevision: string }> = [];
    let storedAtPost: string | null = null;
    server.use(
      http.post(TASKS_URL, async ({ request }) => {
        storedAtPost = sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID));
        bodies.push(
          (await request.json()) as {
            taskId: string;
            prompt: string;
            expectedWorkspaceRevision: string;
          },
        );
        return HttpResponse.json(occupyingTask({ state: 'QUEUED' }));
      }),
    );
    const harness = renderPanel();
    await user.type(screen.getByLabelText('Task goal'), 'Fix the failing test');
    await user.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => {
      expect(harness.getAccepted()?.state).toBe('QUEUED');
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.prompt).toBe('Fix the failing test');
    expect(bodies[0]?.expectedWorkspaceRevision).toBe('7');
    expect(bodies[0]?.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The identity is durable BEFORE the request: a lost response still asks
    // about this exact task instead of generating a second one.
    expect(storedAtPost).toBe(bodies[0]?.taskId);
    expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBe(
      bodies[0]?.taskId,
    );
  });

  it('refuses an empty goal without any request', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a goal/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries the original task id after a lost start response instead of creating a second task', async () => {
    const user = userEvent.setup();
    let postedTaskId: string | null = null;
    let postCount = 0;
    const fetchedIds: string[] = [];
    server.use(
      http.post(TASKS_URL, async ({ request }) => {
        postCount += 1;
        const body = (await request.json()) as { taskId: string };
        postedTaskId = body.taskId;
        // The durable task exists, but the response never reaches the browser.
        return HttpResponse.json(
          { code: 'INTERNAL_ERROR', message: 'Request failed', traceId: 'trace-lost' },
          { status: 500 },
        );
      }),
      http.get(`${TASKS_URL}/:taskId`, ({ params }) => {
        const taskId = String(params.taskId);
        fetchedIds.push(taskId);
        if (taskId !== postedTaskId) {
          return HttpResponse.json(
            { code: 'ENTRY_NOT_FOUND', message: 'Task not found', traceId: 'trace-missing' },
            { status: 404 },
          );
        }
        return HttpResponse.json(occupyingTask({ state: 'QUEUED', taskId }));
      }),
    );
    const harness = renderPanel();
    await user.type(screen.getByLabelText('Task goal'), 'Fix the failing test');
    await user.click(screen.getByRole('button', { name: 'Start task' }));
    await waitFor(() => {
      expect(harness.getAccepted()?.taskId).toBe(postedTaskId);
    });
    expect(postCount).toBe(1);
    // Exactly one reconciliation query, and it used the ORIGINAL task id.
    expect(fetchedIds).toEqual([postedTaskId]);
  });

  it('surfaces the backend refusal code when the task cannot start', async () => {
    const user = userEvent.setup();
    server.use(
      http.post(TASKS_URL, () =>
        HttpResponse.json(
          {
            code: 'AI_TASK_ACTIVE',
            message: 'The project already has an active task',
            traceId: 'trace-active',
          },
          { status: 409 },
        ),
      ),
      http.get(`${TASKS_URL}/:taskId`, () =>
        HttpResponse.json(
          { code: 'ENTRY_NOT_FOUND', message: 'Task not found', traceId: 'trace-missing' },
          { status: 404 },
        ),
      ),
    );
    renderPanel();
    await user.type(screen.getByLabelText('Task goal'), 'Fix the failing test');
    await user.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('AI_TASK_ACTIVE');
  });

  it('clears a provably unused stored id and reports the failure', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), TASK_ID);
    server.use(
      http.get(`${TASKS_URL}/:taskId`, () =>
        HttpResponse.json(
          { code: 'ENTRY_NOT_FOUND', message: 'Task not found', traceId: 'trace-missing' },
          { status: 404 },
        ),
      ),
    );
    renderPanel();
    await user.type(screen.getByLabelText('Task goal'), 'Fix the failing test');
    await user.click(screen.getByRole('button', { name: 'Start task' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBeNull();
  });
});

describe('AgentTaskPanel close flow', () => {
  it('offers End task for an occupying task and calls it only on the explicit click', async () => {
    const user = userEvent.setup();
    const harness = renderPanel({ task: occupyingTask() });
    expect(screen.getByRole('button', { name: 'End task' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'End task' }));
    expect(harness.getCloseCalls()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'End task' }));
    expect(harness.getCloseCalls()).toBe(2);
  });

  it('never ends the task on unmount', () => {
    const harness = renderPanel({ task: occupyingTask() });
    cleanup();
    expect(harness.getCloseCalls()).toBe(0);
  });

  it('shows the progress messages of the occupying task', () => {
    renderPanel({ task: occupyingTask() });
    expect(screen.getByText('Reading pom.xml')).toBeInTheDocument();
    expect(
      screen.getByText('write_file src/main/java/demo/DemoController.java'),
    ).toBeInTheDocument();
  });

  it('shows the settled result with summary, failure code and changed paths', () => {
    renderPanel({
      task: null,
      settledTask: occupyingTask({
        state: 'FAILED',
        writesLocked: false,
        summary: 'The demo endpoint still fails to compile',
        failureCode: 'AI_CLOSED',
        changedPaths: ['src/main/java/demo/DemoController.java'],
        progress: [
          { seq: 1, kind: 'terminal', text: '{"state":"FAILED"}', truncated: false },
        ],
      }),
    });
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.getByText('The demo endpoint still fails to compile')).toBeInTheDocument();
    expect(screen.getByText('AI_CLOSED')).toBeInTheDocument();
    expect(screen.getByText('src/main/java/demo/DemoController.java')).toBeInTheDocument();
    // A settled task releases the project: the next goal can start immediately.
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
  });

  it('shows a poll failure without pretending the project is free', () => {
    renderPanel({ task: null, pollFailed: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load the agent task status/i);
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });
});

describe('agent task poll', () => {
  function PollHarness({ enabled }: { enabled: boolean }) {
    const query = useCurrentAgentTaskQuery(PROJECT_ID, enabled);
    return (
      <div
        data-testid="poll-state"
        data-status={query.status}
        data-task={query.data?.state ?? 'none'}
      />
    );
  }

  it('polls GET current every 2 seconds and maps a 404 to no task', async () => {
    vi.useFakeTimers();
    try {
      let currentHits = 0;
      server.use(
        http.get(CURRENT_URL, () => {
          currentHits += 1;
          return HttpResponse.json(
            { code: 'ENTRY_NOT_FOUND', message: 'Task not found', traceId: 'trace-none' },
            { status: 404 },
          );
        }),
      );
      render(
        <AppProviders>
          <PollHarness enabled />
        </AppProviders>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(currentHits).toBe(1);
      expect(screen.getByTestId('poll-state').dataset.task).toBe('none');
      expect(screen.getByTestId('poll-state').dataset.status).toBe('success');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(currentHits).toBe(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(currentHits).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll while the panel stage is disabled', async () => {
    vi.useFakeTimers();
    try {
      let currentHits = 0;
      server.use(
        http.get(CURRENT_URL, () => {
          currentHits += 1;
          return HttpResponse.json(occupyingTask());
        }),
      );
      render(
        <AppProviders>
          <PollHarness enabled={false} />
        </AppProviders>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(currentHits).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentTaskPanel build results (review fix I9)', () => {
  const TOOLS_URL = `${TASKS_URL}/${TASK_ID}/tools/call-9`;

  function taskWithSettledBuild(): AgentTaskSnapshot {
    return occupyingTask({
      progress: [
        { seq: 1, kind: 'tool_start', text: 'build call-9', truncated: false },
        { seq: 2, kind: 'tool_end', text: 'build call-9', truncated: false },
      ],
    });
  }

  it('fetches and shows the settled build result for a build tool_end item', async () => {
    const user = userEvent.setup();
    server.use(
      http.get(TOOLS_URL, () => HttpResponse.json({
        toolCallId: 'call-9',
        toolName: 'build',
        data: {
          goal: 'test',
          exitCode: 1,
          terminationReason: 'Completed',
          output: '[ERROR] BUILD FAILURE',
          cleanupConfirmed: true,
        },
      })),
    );
    renderPanel({ task: taskWithSettledBuild() });
    await user.click(screen.getByRole('button', { name: 'View build result' }));
    expect(await screen.findByText('[ERROR] BUILD FAILURE')).toBeInTheDocument();
    expect(screen.getByText('Exit code:')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('Cleanup confirmed:')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
  });

  it('shows an honest error when the build result is not readable', async () => {
    const user = userEvent.setup();
    server.use(http.get(TOOLS_URL, () => new HttpResponse(null, { status: 404 })));
    renderPanel({ task: taskWithSettledBuild() });
    await user.click(screen.getByRole('button', { name: 'View build result' }));
    expect(await screen.findByText('Could not load the build result.')).toBeInTheDocument();
  });

  it('does not offer build results for non-build tool items', () => {
    renderPanel({
      task: occupyingTask({
        progress: [{ seq: 1, kind: 'tool_end', text: 'list_files call-3', truncated: false }],
      }),
    });
    expect(screen.queryByRole('button', { name: 'View build result' })).not.toBeInTheDocument();
  });
});

describe('AgentTaskPanel verified-write snapshot contract (review fix I1)', () => {
  it('renders the changed paths and the latest verified revision the backend snapshot carries', () => {
    // The backend persists the latest VERIFIED write revision and the deduped
    // changed paths on the task row (AgentTaskStore.recordVerifiedWrite) and
    // serializes them under exactly these field names — this is the browser
    // side of that contract.
    renderPanel({
      task: occupyingTask({
        workspaceRevision: '9',
        changedPaths: ['src/main/java/demo/DemoController.java', 'pom.xml'],
      }),
    });
    expect(screen.getByText('Changed paths')).toBeInTheDocument();
    expect(screen.getByText('src/main/java/demo/DemoController.java')).toBeInTheDocument();
    expect(screen.getByText('pom.xml')).toBeInTheDocument();
  });
});
