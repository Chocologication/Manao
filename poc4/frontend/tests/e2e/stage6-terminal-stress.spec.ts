import { expect, test } from '@playwright/test';

/**
 * Stage 6A: terminal/log stress over the real backend. Reuses the stage6-real-backend helpers
 * (gate guard, login, token, project/run lifecycle) and drives the terminal and run-log
 * WebSocket protocols directly inside the browser page. Outside a gate run (STAGE6_GATE != 1)
 * the suite skips when the backend is unreachable; inside a gate run an unreachable backend
 * fails loudly.
 */

const ALICE = { username: 'alice', password: 'stage6-alice-pass' };
const BOB = { username: 'bob', password: 'stage6-bob-pass' };
const GATE_MODE = process.env.STAGE6_GATE === '1';

async function backendReachable(request: import('@playwright/test').APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/api/v1/projects');
    return [200, 401].includes(response.status());
  } catch {
    return false;
  }
}

test.beforeEach(async ({ request }) => {
  const reachable = await backendReachable(request);
  if (!reachable) {
    test.skip(!GATE_MODE, '6A backend not reachable; gate-only suite');
    expect(reachable, '6A gate: backend must be reachable').toBe(true);
  }
});

async function login(page: import('@playwright/test').Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel(/Username|用户名/i).fill(user.username);
  await page.getByLabel(/Password|密码/i).fill(user.password);
  await page.getByRole('button', { name: /Sign in|登录|login/i }).click();
  await expect(page.getByText(/Projects|项目/i).first()).toBeVisible();
}

/** Fetches a fresh JWT for API calls; the in-memory auth store never persists it. */
async function apiToken(page: import('@playwright/test').Page, user: { username: string; password: string }): Promise<string> {
  const res = await page.request.post('/api/v1/auth/login', { data: { username: user.username, password: user.password } });
  expect(res.status(), 'login must issue a token').toBe(200);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

function authHeaders(token: string) {
  return { Authorization: 'Bearer ' + token };
}

async function createProject(page: import('@playwright/test').Page, name: string, token: string): Promise<{ id: string; state: string }> {
  const created = await page.request.post('/api/v1/projects', { data: { name }, headers: authHeaders(token) });
  expect(created.status()).toBe(201);
  return (await created.json()) as { id: string; state: string };
}

async function awaitReady(page: import('@playwright/test').Page, projectId: string, token: string): Promise<string> {
  let state = 'CREATING';
  for (let i = 0; i < 60 && state === 'CREATING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fetched = await page.request.get('/api/v1/projects/' + projectId, { headers: authHeaders(token) });
    state = (await fetched.json()).state as string;
  }
  return state;
}

/** Starts the policy-constrained run (mvn clean test) and returns its id/state. */
async function startRun(page: import('@playwright/test').Page, projectId: string, token: string): Promise<{ id: string; state: string }> {
  const tree = (await (await page.request.get('/api/v1/projects/' + projectId + '/files/tree?path=', { headers: authHeaders(token) })).json())
    .workspaceRevision as string;
  const started = await page.request.post('/api/v1/projects/' + projectId + '/runs', {
    data: { expectedWorkspaceRevision: tree },
    headers: authHeaders(token),
  });
  expect(started.status()).toBe(202);
  return (await started.json()) as { id: string; state: string };
}

/** Polls a run until its state is one of targetStates; returns the final observed state. */
async function awaitRunState(
  page: import('@playwright/test').Page,
  projectId: string,
  runId: string,
  token: string,
  targetStates: string[],
  maxIterations = 150,
): Promise<string> {
  let state = '';
  for (let i = 0; i < maxIterations; i++) {
    const fetched = await page.request.get('/api/v1/projects/' + projectId + '/runs/' + runId, { headers: authHeaders(token) });
    state = (await fetched.json()).state as string;
    if (targetStates.includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return state;
}

/** Reserves a single terminal session for the RUNNING run; returns the single-use ticket. */
async function createTerminalSession(
  page: import('@playwright/test').Page,
  projectId: string,
  runId: string,
  token: string,
): Promise<{ sessionId: string; ticket: string; expiresAt: string }> {
  const res = await page.request.post('/api/v1/projects/' + projectId + '/runs/' + runId + '/terminal-sessions', {
    data: { cols: 80, rows: 24 },
    headers: authHeaders(token),
  });
  expect(res.ok(), 'terminal session must be reservable for a RUNNING run').toBe(true);
  return (await res.json()) as { sessionId: string; ticket: string; expiresAt: string };
}
test('PTY 8 MiB output in <=32 KiB frames conserves 256 KiB credit', async ({ page }) => {
  test.setTimeout(600_000);
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await createProject(page, 'stage6-stress-' + Date.now(), token);
  expect(await awaitReady(page, project.id, token), 'stress requires a READY project').toBe('READY');
  const run = await startRun(page, project.id, token);
  expect(await awaitRunState(page, project.id, run.id, token, ['RUNNING']), 'terminal requires a RUNNING run').toBe('RUNNING');
  const session = await createTerminalSession(page, project.id, run.id, token);

  const metrics = await page.evaluate(async ({ ticket }) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + location.host + '/api/v1/ws/terminals?ticket=' + encodeURIComponent(ticket);
    const MAX_INPUT = 16 * 1024;
    const MAX_OUTPUT = 32 * 1024;
    const CREDIT = 256 * 1024;
    const INPUT_QUEUE = 64 * 1024;
    const TARGET = 8 * 1024 * 1024;
    const STOP_THRESHOLD = CREDIT - MAX_OUTPUT;
    const QUIET_MS = 1500;
    const INPUT_BURST_BYTES = 4 * INPUT_QUEUE;

    let totalDelivered = 0;
    let maxOutputFrame = 0;
    let outstanding = 0;
    let maxOutstanding = 0;
    let maxInputFrame = 0;
    let inputFrames = 0;
    let resizeGeneration = 0;
    let inputPauses = 0;
    let inputResumes = 0;
    let sentWhilePaused = 0;
    let framesAfterAck = 0;
    let lastOutputAt = 0;
    let finished = false;
    let inputPaused = false;
    let phase = 0;

    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    const wait = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

    function sendInput(data: Uint8Array): void {
      if (inputPaused) sentWhilePaused += 1;
      maxInputFrame = Math.max(maxInputFrame, data.byteLength);
      inputFrames += 1;
      socket.send(data);
    }

    function sendResize(cols: number, rows: number): void {
      socket.send(JSON.stringify({ type: 'terminal.resize', cols, rows }));
      resizeGeneration += 1;
    }

    await new Promise<void>((resolve, reject) => {
      const deadline = window.setTimeout(() => {
        if (finished) return;
        try { socket.close(); } catch { /* noop */ }
        reject(new Error('terminal stress timed out'));
      }, 560_000);

      socket.addEventListener('open', () => { /* wait for terminal.ready */ });

      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data) as { type?: string };
          if (frame.type === 'terminal.ready') {
            void runScenario();
          } else if (frame.type === 'terminal.input.pause') {
            inputPaused = true;
            inputPauses += 1;
          } else if (frame.type === 'terminal.input.resume') {
            inputPaused = false;
            inputResumes += 1;
          }
          return;
        }
        const bytes = event.data.byteLength;
        lastOutputAt = Date.now();
        maxOutputFrame = Math.max(maxOutputFrame, bytes);
        totalDelivered += bytes;
        outstanding += bytes;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        if (phase !== 0) {
          framesAfterAck += 1;
          socket.send(JSON.stringify({ type: 'terminal.output.ack', bytes }));
          outstanding -= bytes;
        }
      });

      socket.addEventListener('error', () => {
        if (finished) return;
        window.clearTimeout(deadline);
        reject(new Error('terminal websocket error'));
      });

      socket.addEventListener('close', () => {
        if (finished) return;
        window.clearTimeout(deadline);
        resolve();
      });

      async function runScenario(): Promise<void> {
        try {
          sendResize(80, 24);
          const command = "head -c 8388608 /dev/zero | tr '\\0' 'x'\n";
          sendInput(new TextEncoder().encode(command));
          for (let i = 0; i < 120; i += 1) {
            sendResize(80 + (i % 40), 24);
            await wait(1);
          }

          // Drain phase: hold every ack until the server stops at its 256 KiB credit ceiling.
          while (outstanding < STOP_THRESHOLD || Date.now() - lastOutputAt < QUIET_MS) {
            if (totalDelivered >= TARGET) break;
            await wait(50);
          }

          // Ack the held bytes once; the server restores credit and flushes pending output.
          const held = outstanding;
          if (held > 0) {
            socket.send(JSON.stringify({ type: 'terminal.output.ack', bytes: held }));
            outstanding -= held;
          }
          phase = 1;

          // Stream the remaining output with per-frame acks.
          while (totalDelivered < TARGET) {
            await wait(50);
          }

          // Input-burst flow control: exceed the 64 KiB queue while respecting pause/resume.
          phase = 2;
          const chunk = new Uint8Array(MAX_INPUT).fill('a'.charCodeAt(0));
          let sent = 0;
          while (sent < INPUT_BURST_BYTES) {
            while (inputPaused) await wait(25);
            const length = Math.min(MAX_INPUT, INPUT_BURST_BYTES - sent);
            sendInput(length === MAX_INPUT ? chunk : chunk.slice(0, length));
            sent += length;
            await wait(1);
          }
          sendInput(new TextEncoder().encode('\n'));

          const burstDeadline = Date.now() + 20_000;
          while ((inputPauses === 0 || inputResumes === 0) && Date.now() < burstDeadline) {
            await wait(50);
          }

          finished = true;
          window.clearTimeout(deadline);
          try { socket.close(); } catch { /* noop */ }
          resolve();
        } catch (error) {
          window.clearTimeout(deadline);
          try { socket.close(); } catch { /* noop */ }
          reject(error);
        }
      }
    });

    return {
      totalDelivered,
      maxOutputFrame,
      maxOutstanding,
      maxInputFrame,
      inputFrames,
      resizeGeneration,
      inputPauses,
      inputResumes,
      sentWhilePaused,
      framesAfterAck,
    };
  }, { ticket: session.ticket });

  expect(metrics.maxInputFrame, 'each input frame must stay <= 16 KiB').toBeLessThanOrEqual(16384);
  expect(metrics.maxOutputFrame, 'each output frame must stay <= 32 KiB').toBeLessThanOrEqual(32768);
  expect(metrics.totalDelivered, 'remote output must reach at least 8 MiB').toBeGreaterThanOrEqual(8388608);
  expect(metrics.maxOutstanding, 'unacknowledged output must never exceed 256 KiB credit').toBeLessThanOrEqual(262144);
  expect(metrics.maxOutstanding, 'delayed acks must let outstanding approach the 256 KiB ceiling').toBeGreaterThanOrEqual(229376);
  expect(metrics.framesAfterAck, 'frames must resume after the held credit is acked').toBeGreaterThanOrEqual(1);
  expect(metrics.sentWhilePaused, 'no input may be sent while the server queue is paused').toBe(0);
  expect(metrics.inputPauses, 'the 64 KiB input queue must fill and pause').toBeGreaterThanOrEqual(1);
  expect(metrics.inputResumes, 'the input queue must drain and resume').toBeGreaterThanOrEqual(1);
  expect(metrics.resizeGeneration, 'at least 100 resize events must be sent').toBeGreaterThanOrEqual(100);
});

test('run log live then full replay matches byte conservation', async ({ page }) => {
  test.setTimeout(360_000);
  await login(page, ALICE);
  const token = await apiToken(page, ALICE);
  const project = await createProject(page, 'stage6-log-' + Date.now(), token);
  expect(await awaitReady(page, project.id, token), 'log test requires a READY project').toBe('READY');
  const run = await startRun(page, project.id, token);

  const result = await page.evaluate(async ({ token, projectId, runId }) => {
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const runUrl = '/api/v1/projects/' + encodeURIComponent(projectId) + '/runs/' + encodeURIComponent(runId);
    const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

    async function runState(): Promise<string> {
      const res = await fetch(runUrl, { headers });
      if (!res.ok) throw new Error('run state fetch failed: ' + res.status);
      const body = await res.json();
      return body.state as string;
    }

    async function issueTicket(): Promise<string> {
      const res = await fetch(runUrl + '/log-ticket', { method: 'POST', headers });
      if (!res.ok) throw new Error('log-ticket fetch failed: ' + res.status);
      const body = await res.json();
      return body.ticket as string;
    }

    function openLogSocket(ticket: string, onChunk: (bytes: number) => void, onType: (type: string) => void): WebSocket {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = protocol + '//' + location.host + '/api/v1/ws/run-logs?ticket=' + encodeURIComponent(ticket);
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'log.subscribe', lastSeq: null }));
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data) as { type?: string; chunks?: { byteLength: number }[]; chunk?: { byteLength: number } };
        if (frame.type === 'log.replay' && Array.isArray(frame.chunks)) {
          for (const chunk of frame.chunks) onChunk(chunk.byteLength);
        } else if (frame.type === 'log.append' && frame.chunk !== undefined) {
          onChunk(frame.chunk.byteLength);
        }
        if (frame.type !== undefined) onType(frame.type);
      });
      return socket;
    }

    let liveBytes = 0;
    let replayBytes = 0;

    // Live phase: subscribe immediately after start and collect every persisted chunk.
    const liveTicket = await issueTicket();
    await new Promise<void>((resolve, reject) => {
      const socket = openLogSocket(liveTicket, (bytes) => { liveBytes += bytes; }, () => {});
      void (async () => {
        try {
          let terminal = false;
          for (let i = 0; i < 60; i += 1) {
            const state = await runState();
            if (TERMINAL_STATES.includes(state)) {
              terminal = true;
              break;
            }
            await new Promise((r) => window.setTimeout(r, 2000));
          }
          if (!terminal) {
            throw new Error('run did not reach a terminal state within 120s');
          }
          // Grace for the final persisted appends to flush over the live socket.
          await new Promise((r) => window.setTimeout(r, 3000));
          try { socket.close(); } catch { /* noop */ }
          resolve();
        } catch (error) {
          try { socket.close(); } catch { /* noop */ }
          reject(error);
        }
      })();
    });

    // Replay phase: a fresh ticket with lastSeq null replays the full retained window.
    const replayTicket = await issueTicket();
    await new Promise<void>((resolve, reject) => {
      const socket = openLogSocket(replayTicket, (bytes) => { replayBytes += bytes; }, (type) => {
        if (type === 'log.complete') {
          try { socket.close(); } catch { /* noop */ }
          resolve();
        }
      });
      socket.addEventListener('error', () => reject(new Error('replay websocket error')));
      socket.addEventListener('close', () => resolve());
    });

    return { liveBytes, replayBytes };
  }, { token, projectId: project.id, runId: run.id });

  expect(result.replayBytes, 'full replay must conserve every live byte').toBe(result.liveBytes);
  expect(result.replayBytes, 'the run must produce a non-empty log').toBeGreaterThan(0);
});
