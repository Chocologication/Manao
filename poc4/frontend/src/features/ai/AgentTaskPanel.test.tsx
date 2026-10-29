import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { fetchCurrentAgentTask, useCurrentAgentTaskQuery } from './agentTaskQueries';
import { AgentTaskPanel, type AgentTaskPanelProps } from './AgentTaskPanel';
import { parseAgentTaskSnapshot } from '@/contracts/agentTask';

const PROJECT_ID = ALICE_SEED_PROJECT_ID;
it('clears an accepted goal so Continue defaults to the continuation instruction', async () => {
  server.use(http.post(TASKS_URL, async ({request}) => {
    const body = await request.json() as {taskId:string}; return HttpResponse.json(occupyingTask({taskId:body.taskId}));
  }));
  const h=renderPanel();
  await userEvent.type(screen.getByLabelText('Task goal'), 'previous task goal');
  await userEvent.click(screen.getByRole('button',{name:'Start task'}));
  await waitFor(()=>expect(h.getAccepted()).not.toBeNull());
  expect(screen.getByLabelText('Task goal')).toHaveValue('');
});
it('keeps continuation disabled while a pause is settling', () => {
  renderPanel({ conversationId: 'conversation-a', task: { ...occupyingTask({ state: 'NEEDS_ATTENTION' }),
    conversationId: 'conversation-a', closeReasonCode: 'AI_PAUSED_BY_OWNER' } as AgentTaskSnapshot });
  expect(screen.getByRole('button', { name: 'Continue task' })).toBeDisabled();
  expect(screen.getByText(/Stopping and verifying/)).toBeVisible();
});
it('continues the selected conversation with a new id and the latest saved revision', async () => {
  let posted: Record<string, unknown> | null = null;
  server.use(http.post(`/api/v1/projects/${PROJECT_ID}/conversations/conversation-a/tasks`, async ({ request }) => {
    posted = await request.json() as Record<string, unknown>;
    return HttpResponse.json(occupyingTask({ taskId: String(posted.taskId), conversationId: 'conversation-a', workspaceRevision: '9' }));
  }));
  queryClient.setQueryData(fileKeys.revision(PROJECT_ID), '9');
  const h = renderPanel({ conversationId: 'conversation-a', settledTask: {
    ...occupyingTask({ state: 'FAILED', writesLocked: false, conversationId: 'conversation-a' }), closeReasonCode: 'AI_PAUSED_BY_OWNER',
  } as AgentTaskSnapshot });
  await userEvent.click(screen.getByRole('button', { name: 'Continue task' }));
  await waitFor(() => expect(h.getAccepted()).not.toBeNull());
  expect(posted).toMatchObject({ expectedWorkspaceRevision: '9' });
  const sent = posted as Record<string, unknown> | null;
  expect(sent?.taskId).not.toBe(TASK_ID);
  expect(String(sent?.prompt)).toContain('不要重放');
});
it('retains dirty edits and blocks continuation after a safe pause', () => {
  act(() => workspaceSessionStore.getState().setDirty(parseProjectRelativePath('pom.xml'), true));
  renderPanel({ conversationId: 'conversation-a', settledTask: {
    ...occupyingTask({ state: 'FAILED', writesLocked: false, conversationId: 'conversation-a' }), closeReasonCode: 'AI_PAUSED_BY_OWNER',
  } as AgentTaskSnapshot });
  expect(screen.getByRole('button', { name: 'Continue task' })).toBeDisabled();
  expect(workspaceSessionStore.getState().dirtyPaths.size).toBe(1);
});
it('shows startup pause as disabled while End task remains available', () => {
  renderPanel({ task: occupyingTask({ state: 'QUEUED' }) });
  expect(screen.getByRole('button', { name: 'Pause & take over' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'End task' })).toBeEnabled();
});
it('reads the optional close reason without inventing one for legacy JSON', () => {
  expect(parseAgentTaskSnapshot(occupyingTask()).closeReasonCode).toBeNull();
  expect(parseAgentTaskSnapshot({ ...occupyingTask(), closeReasonCode: 'AI_PAUSED_BY_OWNER' }).closeReasonCode).toBe('AI_PAUSED_BY_OWNER');
  expect(() => parseAgentTaskSnapshot({ ...occupyingTask(), closeReasonCode: 1 })).toThrow();
});
it('places conversation presentation before the bottom submission form', () => {
  renderPanel({ conversationHeader: <h2>当前会话</h2>, conversationHistory: <p>历史正文</p> });
  const header = screen.getByRole('heading', { name: '当前会话' });
  const history = screen.getByText('历史正文');
  const form = screen.getByLabelText('Task goal').closest('form')!;
  expect(header.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(history.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(form.parentElement).toBe(screen.getByRole('region', { name: 'AI task' }));
});
const USER_ID = 'user-alice';
const TASK_ID = '0b8fd38f-0f9e-4c28-9c48-3f5f4a2b1c11';
const CURRENT_URL = `/api/v1/projects/${PROJECT_ID}/agent-tasks/current`;
const TASKS_URL = `/api/v1/projects/${PROJECT_ID}/agent-tasks`;
it('reconciles a lost-response task that already completed without submitting another round', async () => {
  sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), JSON.stringify({taskId:TASK_ID,conversationId:'conversation-a'}));
  let posts=0;
  const original=occupyingTask({state:'COMPLETED',writesLocked:false,conversationId:'conversation-a'});
  server.use(http.get(`${TASKS_URL}/${TASK_ID}`,()=>HttpResponse.json(original)),
    http.post(`/api/v1/projects/${PROJECT_ID}/conversations/conversation-a/tasks`,()=>{posts++;return HttpResponse.error();}));
  const h=renderPanel({conversationId:'conversation-a'});
  await userEvent.type(screen.getByLabelText('Task goal'),'retry the uncertain intent');
  await userEvent.click(screen.getByRole('button',{name:'Start task'}));
  await waitFor(()=>expect(h.getAccepted()?.taskId).toBe(TASK_ID));
  expect(posts).toBe(0);
  expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID,PROJECT_ID))).toBeNull();
});
it('keeps effort locked after both POST and original task GET fail, and retries only the original GET', async () => {
  let posts = 0, original = ''; const gets: string[] = [];
  server.use(http.post(TASKS_URL, async ({ request }) => { posts++; original = (await request.json() as { taskId: string }).taskId; return HttpResponse.error(); }),
    http.get(`${TASKS_URL}/:id`, ({ params }) => { gets.push(String(params.id)); return HttpResponse.error(); }));
  renderPanel();
  await userEvent.click(screen.getByRole('button', { name: /推理强度/ })); fireEvent.change(screen.getByRole('slider', { name: '推理强度' }), { target: { value: '3' } }); await userEvent.keyboard('{Escape}');
  await userEvent.type(screen.getByLabelText('Task goal'), 'do work');
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: /推理强度/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /推理强度/ })).toHaveTextContent('推理强度 · 最高');
  expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBe(original);
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await screen.findByText('Could not verify the previous task. Try again in a moment.');
  expect(gets).toEqual([original, original]); expect(posts).toBe(1);
  expect(screen.getByRole('button', { name: /推理强度/ })).toBeDisabled();
});
it('locks a retained unknown identity on remount and releases effort after confirmed absence', async () => {
  sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), TASK_ID);
  let posts = 0;
  const absent = () => HttpResponse.json({ code: 'ENTRY_NOT_FOUND', message: 'none', traceId: 'none' }, { status: 404 });
  server.use(http.get(`${TASKS_URL}/:id`, absent), http.post(TASKS_URL, () => { posts++; return absent(); }));
  renderPanel();
  expect(screen.getByRole('button', { name: /推理强度/ })).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Task goal'), 'do work');
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await screen.findByRole('alert');
  expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBeNull();
  expect(screen.getByRole('button', { name: /推理强度/ })).toBeEnabled(); expect(posts).toBe(1);
});
it('submits the chosen effort and locks it while admission is unknown', async () => {
  let posted: Record<string, unknown> | null = null, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  server.use(http.post(TASKS_URL, async ({ request }) => { posted = await request.json() as Record<string, unknown>; await held; return HttpResponse.error(); }),
    http.get(`${TASKS_URL}/:id`, ({ params }) => HttpResponse.json(occupyingTask({ taskId: String(params.id) }))));
  const h = renderPanel();
  await userEvent.click(screen.getByRole('button', { name: /推理强度/ })); fireEvent.change(screen.getByRole('slider', { name: '推理强度' }), { target: { value: '3' } }); await userEvent.keyboard('{Escape}');
  await userEvent.type(screen.getByLabelText('Task goal'), 'do work');
  await userEvent.click(screen.getByRole('button', { name: 'Start task' }));
  await waitFor(() => expect(posted).toMatchObject({ reasoningEffort: 'max' }));
  expect(screen.getByRole('button', { name: /推理强度/ })).toBeDisabled();
  release(); await waitFor(() => expect(h.getAccepted()).not.toBeNull());
});
it('shows old effort as unrecorded and explains the final output limit', () => {
  renderPanel({ settledTask: occupyingTask({ state: 'FAILED', writesLocked: false, failureCode: 'AI_LENGTH_LIMIT' }) });
  expect(screen.getByText('本轮推理强度：未记录')).toBeInTheDocument();
  expect(screen.getByText('模型响应达到输出上限，本条内容可能不完整')).toBeInTheDocument();
});

it('parses nullable conversation association without inventing old task history', () => {
  expect(parseAgentTaskSnapshot(occupyingTask()).conversationId).toBeNull();
  expect(parseAgentTaskSnapshot({ ...occupyingTask(), conversationId: 'conversation-a' }).conversationId).toBe('conversation-a');
  expect(() => parseAgentTaskSnapshot({ ...occupyingTask(), conversationId: 123 })).toThrow();
});

it('does not clear a newer project pending identity when an old terminal snapshot arrives', () => {
  sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), 'new-task-id');
  renderPanel({ task: occupyingTask({ state: 'COMPLETED', writesLocked: false }) });
  expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBe('new-task-id');
});

it('does not adopt a newly persisted submission while an older current discovery read is in flight', async () => {
  let release = () => {}, started = false, originalReads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  server.use(http.get(CURRENT_URL, async () => { started = true; await held; return HttpResponse.json({ code: 'ENTRY_NOT_FOUND', message: 'none', traceId: 'none' }, { status: 404 }); }), http.get(`${TASKS_URL}/${TASK_ID}`, () => { originalReads++; return HttpResponse.json({ code: 'ENTRY_NOT_FOUND', message: 'none', traceId: 'none' }, { status: 404 }); }));
  const read = fetchCurrentAgentTask(PROJECT_ID, USER_ID);
  await waitFor(() => expect(started).toBe(true));
  sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), JSON.stringify({ taskId: TASK_ID, conversationId: 'conversation-a' }));
  release(); await read;
  expect(originalReads).toBe(0); expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).not.toBeNull();
});

it('keeps pending identity when the shell reconciliation response has a different conversation', async () => {
  const original = JSON.stringify({ taskId: TASK_ID, conversationId: 'conversation-a' });
  sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), original);
  server.use(http.get(`${TASKS_URL}/${TASK_ID}`, () => HttpResponse.json({ ...occupyingTask(), conversationId: 'conversation-b' })));
  await expect(fetchCurrentAgentTask(PROJECT_ID, USER_ID)).rejects.toThrow();
  expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBe(original);
});

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
        runAuthorityKnown
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

  it('allows a running application but keeps reload blocked', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPanel({ hasActiveRun: true });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    renderPanel({ reloading: true });
    expect(screen.getAllByText('RELOADING').length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks unknown Run authority explicitly', () => {
    renderPanel({ hasActiveRun: true, runAuthorityKnown: false });
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('RUN_AUTHORITY_UNKNOWN')).toBeInTheDocument();
  });

  it('does not POST while the workspace revision is unknown', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    queryClient.removeQueries({ queryKey: fileKeys.revision(PROJECT_ID) });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText('REVISION_UNAVAILABLE')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reacts when a missing workspace revision is restored from a file read', async () => {
    queryClient.removeQueries({ queryKey: fileKeys.revision(PROJECT_ID) });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();

    act(() => {
      queryClient.setQueryData(fileKeys.revision(PROJECT_ID), '8');
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled();
    });
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
  it('keeps current task ending reachable while a historical task is displayed', async () => {
    const harness = renderPanel({ task: occupyingTask(), displayTask: occupyingTask({ taskId: 'history-task', state: 'COMPLETED', writesLocked: false }) });
    expect(screen.getByText(/Ending the AI task may stop applications it started/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'End task' }));
    expect(harness.getCloseCalls()).toBe(1);
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
    expect(screen.getByText(/AI task time budget is separate/)).toBeVisible();
  });

  it('offers retry ending and shows settlement without releasing the task identity', async () => {
    sessionStorage.setItem(agentTaskStorageKey(USER_ID, PROJECT_ID), TASK_ID);
    const harness = renderPanel({ task: occupyingTask({ state: 'NEEDS_ATTENTION', failureCode: 'AI_CLOSING' }) });
    expect(screen.getByRole('status', { name: 'Task settlement' })).toHaveTextContent(/Waiting for confirmation/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry ending task' }));
    expect(harness.getCloseCalls()).toBe(1);
    expect(sessionStorage.getItem(agentTaskStorageKey(USER_ID, PROJECT_ID))).toBe(TASK_ID);
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });

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

  it('renders the legacy assistant summary as Markdown', () => {
    renderPanel({ task: null, settledTask: occupyingTask({ state: 'FAILED', writesLocked: false, summary: '# 完成\n\n- 已验证\n\n~~~java\nclass A {}\n~~~' }) });
    expect(screen.getByRole('heading', { name: '完成' })).toBeVisible();
    expect(screen.getByText('已验证').tagName).toBe('LI');
    expect(screen.getByText('class A {}').tagName).toBe('CODE');
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
  it.each(['application', 'app_http_get'] as const)('keeps a %s result with an empty Run ID readable without invalid navigation', async (name) => {
    const onViewRun = vi.fn();
    const data = name === 'app_http_get' ? {
      kind: 'app_http_get', runId: '', path: '/health', statusCode: null, contentType: null,
      body: '', truncated: false, error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' },
    } : {
      kind: 'application', action: 'status', run: {
        id: '', state: 'RUNNING', requestedWorkspaceRevision: '19', firstReadyAt: null,
        expiresAt: null, finishedAt: null, exitCode: null, terminationReason: null,
      }, activeRunId: '', stoppedConfirmed: false, logs: null,
    };
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/empty-id`, () => HttpResponse.json({ toolCallId: 'empty-id', toolName: name, data })));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: `${name} empty-id`, truncated: false }] }), onViewRun });
    await userEvent.setup().click(screen.getByRole('button', { name: name === 'application' ? 'View application result' : 'View HTTP result' }));
    expect(await screen.findByText(name === 'application' ? 'Application: status' : /VALIDATION_ERROR/)).toBeInTheDocument();
    const invalidNavigation = screen.queryByRole('button', { name: 'View run' });
    if (invalidNavigation !== null) await userEvent.setup().click(invalidNavigation);
    expect(onViewRun).not.toHaveBeenCalled();
    expect(invalidNavigation).not.toBeInTheDocument();
  });

  it.each(['success', 'error'] as const)('does not let a stale %s or finally clear a new task request', async (outcome) => {
    let releaseOld: (() => void) | undefined;
    let releaseNew: (() => void) | undefined;
    let oldAnswered = false;
    const newTaskId = 'task-new';
    server.use(
      http.get(`${TASKS_URL}/${TASK_ID}/tools/call-9`, async () => {
        await new Promise<void>((resolve) => { releaseOld = resolve; });
        oldAnswered = true;
        return outcome === 'error' ? new HttpResponse(null, { status: 404 }) : HttpResponse.json({ toolCallId: 'call-9', toolName: 'build', data: { output: 'OLD' } });
      }),
      http.get(`${TASKS_URL}/${newTaskId}/tools/call-9`, async () => {
        await new Promise<void>((resolve) => { releaseNew = resolve; });
        return HttpResponse.json({ toolCallId: 'call-9', toolName: 'build', data: { output: 'CURRENT' } });
      }),
    );
    const props: AgentTaskPanelProps = {
      projectId: PROJECT_ID, userId: USER_ID, task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: 'build call-9', truncated: false }] }),
      settledTask: null, pollFailed: false, writePending: false, hasActiveRun: false, runAuthorityKnown: true, reloading: false,
      closePending: false, onTaskAccepted: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<AppProviders><AgentTaskPanel {...props} /></AppProviders>);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'View build result' }));
    await waitFor(() => expect(releaseOld).toBeDefined());
    view.rerender(<AppProviders><AgentTaskPanel {...props} task={{ ...props.task!, taskId: newTaskId }} /></AppProviders>);
    await user.click(screen.getByRole('button', { name: 'View build result' }));
    await waitFor(() => expect(releaseNew).toBeDefined());
    await act(async () => { releaseOld!(); });
    await waitFor(() => expect(oldAnswered).toBe(true));
    expect(screen.getByRole('button', { name: 'View build result' })).toBeDisabled();
    expect(screen.queryByText('Could not load the build result.')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD')).not.toBeInTheDocument();
    await act(async () => { releaseNew!(); });
    expect(await screen.findByText('CURRENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View build result' })).toBeEnabled();
  });

  it('shows a real application rejection without fabricating Run facts', async () => {
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/reject-1`, () => HttpResponse.json({
      toolCallId: 'reject-1', toolName: 'application', data: { error: { code: 'AI_APPLICATION_START_LIMIT', message: 'Application start limit reached' } },
    })));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: 'application reject-1', truncated: false }] }) });
    await userEvent.setup().click(screen.getByRole('button', { name: 'View application result' }));
    expect(await screen.findByText(/AI_APPLICATION_START_LIMIT/)).toBeInTheDocument();
    expect(screen.queryByText(/Ready: yes/)).not.toBeInTheDocument();
  });

  it.each([
    ['application', { kind: 'application', action: 'status', run: { id: 'run-bad', firstReadyAt: true }, activeRunId: null, stoppedConfirmed: true, logs: null }],
    ['app_http_get', { kind: 'app_http_get', runId: 'run-bad', path: '/', statusCode: '200', contentType: null, body: 'bad', truncated: false, error: null }],
    ['app_http_get', { kind: 'application', run: null }],
  ])('refuses malformed or mismatched %s result data', async (name, data) => {
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/bad-1`, () => HttpResponse.json({ toolCallId: 'bad-1', toolName: name, data })));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: `${name} bad-1`, truncated: false }] }) });
    await userEvent.setup().click(screen.getByRole('button', { name: name === 'application' ? 'View application result' : 'View HTTP result' }));
    expect(await screen.findByText('Result unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Ready: yes|Status: 200/)).not.toBeInTheDocument();
  });

  it.each(['task', 'project', 'unmount'] as const)('ignores late tool results after a %s switch', async (switchKind) => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/call-9`, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return HttpResponse.json({ toolCallId: 'call-9', toolName: 'build', data: { exitCode: 9, output: 'STALE-OUTPUT' } });
    }));
    const original = occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: 'build call-9', truncated: false }] });
    const props: AgentTaskPanelProps = {
      projectId: PROJECT_ID, userId: USER_ID, task: original, settledTask: null, pollFailed: false,
      writePending: false, hasActiveRun: false, runAuthorityKnown: true, reloading: false, closePending: false,
      onTaskAccepted: vi.fn(), onClose: vi.fn(),
    };
    const view = render(<AppProviders><AgentTaskPanel {...props} /></AppProviders>);
    await user.click(screen.getByRole('button', { name: 'View build result' }));
    await waitFor(() => expect(release).toBeDefined());
    if (switchKind === 'unmount') view.unmount();
    else view.rerender(<AppProviders><AgentTaskPanel {...props} projectId={switchKind === 'project' ? 'other-project' : PROJECT_ID} task={switchKind === 'task' ? { ...original, taskId: 'other-task' } : original} /></AppProviders>);
    await act(async () => { release!(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('STALE-OUTPUT')).not.toBeInTheDocument();
    if (switchKind !== 'unmount') expect(screen.getByRole('button', { name: 'View build result' })).toBeEnabled();
  });

  it.each([
    ['RUNNING', null, 'no'],
    ['RUNNING', '2026-10-16T10:00:00Z', 'yes'],
    ['FAILED', '2026-10-16T10:00:00Z', 'no'],
  ] as const)('renders actual readiness for %s with firstReadyAt=%s and selects its Run', async (state, firstReadyAt, ready) => {
    const user = userEvent.setup();
    const onViewRun = vi.fn();
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/app-1`, () => HttpResponse.json({
      toolCallId: 'app-1', toolName: 'application', data: {
        kind: 'application', action: 'status', run: {
          id: 'run-real', state, requestedWorkspaceRevision: '19', firstReadyAt,
          expiresAt: null, finishedAt: null, exitCode: null, terminationReason: null,
        }, activeRunId: 'run-real', stoppedConfirmed: false,
        logs: { text: '<script>literal-log</script>', firstSeq: 4, lastSeq: 7, truncated: true, complete: false },
      },
    })));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: 'application app-1', truncated: false }] }), onViewRun });
    await user.click(screen.getByRole('button', { name: 'View application result' }));
    expect(await screen.findByText(/run-real/)).toBeInTheDocument();
    expect(screen.getByText(/Revision: 19/)).toBeInTheDocument();
    expect(screen.getByText(`Ready: ${ready}`)).toBeInTheDocument();
    expect(screen.getByText(/Stopped confirmed: no/)).toBeInTheDocument();
    expect(screen.getByText(/<script>literal-log<\/script>/)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View run' }));
    expect(onViewRun).toHaveBeenCalledWith('run-real');
  });

  it('renders real HTTP status, bounded literal body and structured errors', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/http-1`, () => HttpResponse.json({
      toolCallId: 'http-1', toolName: 'app_http_get', data: {
        kind: 'app_http_get', runId: 'run-real', path: '/api/demo?name=Pi', statusCode: 500,
        contentType: 'text/html', body: '<img src=x onerror=alert(1)>', truncated: true,
        error: { code: 'AI_APP_RUN_CHANGED', message: 'Application changed' },
      },
    })));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: 'app_http_get http-1', truncated: false }] }) });
    await user.click(screen.getByRole('button', { name: 'View HTTP result' }));
    expect(await screen.findByText(/Status: 500/)).toBeInTheDocument();
    expect(screen.getByText(/AI_APP_RUN_CHANGED/)).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByText(/truncated/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each(['build', 'application', 'app_http_get'] as const)('loads the exact provider underscore ID for %s and keeps Run navigation', async (name) => {
    const user = userEvent.setup();
    const id = `call_00_ET_CpH3lmt97CpyOIZ6zI8g3166_${name}`;
    const runId = '1b8fd38f-0f9e-4c28-9c48-3f5f4a2b1c11';
    const onViewRun = vi.fn();
    const requestedIds: string[] = [];
    const data = name === 'build'
      ? { exitCode: 0, cleanupConfirmed: true, output: 'PROVIDER BUILD SUCCESS' }
      : name === 'application'
        ? { kind: 'application', action: 'status', run: { id: runId, state: 'RUNNING', requestedWorkspaceRevision: '7',
          firstReadyAt: '2026-10-16T12:00:00Z', expiresAt: null, finishedAt: null, exitCode: null, terminationReason: null },
          activeRunId: runId, stoppedConfirmed: false, logs: null }
        : { kind: 'app_http_get', runId, path: '/api/demo?name=Pi', statusCode: 200,
          contentType: 'application/json', body: '{"message":"Hello Pi underscore"}', truncated: false, error: null };
    server.use(http.get(`${TASKS_URL}/${TASK_ID}/tools/:id`, ({ params }) => {
      requestedIds.push(String(params.id));
      return HttpResponse.json({ toolCallId: id, toolName: name, data });
    }));
    renderPanel({ task: occupyingTask({ progress: [{ seq: 1, kind: 'tool_end', text: `${name} ${id}`, truncated: false }] }), onViewRun });
    const label = name === 'build' ? 'View build result' : name === 'application' ? 'View application result' : 'View HTTP result';
    await user.click(screen.getByRole('button', { name: label }));
    expect(requestedIds).toEqual([id]);
    if (name === 'build') {
      expect(await screen.findByText('PROVIDER BUILD SUCCESS')).toBeInTheDocument();
      expect(screen.getByText('0')).toBeInTheDocument();
    } else {
      expect(await screen.findByText(name === 'application' ? 'State: RUNNING' : 'Status: 200')).toBeInTheDocument();
      if (name === 'app_http_get') expect(screen.getByText('{"message":"Hello Pi underscore"}')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'View run' }));
      expect(onViewRun).toHaveBeenCalledWith(runId);
    }
  });

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
