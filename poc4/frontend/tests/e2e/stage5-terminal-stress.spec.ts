import { expect, test, type Page } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const PROJECT_ID = 'prj-alice-notebook';
const OUTPUT_BYTES = 8 * 1024 * 1024;
const OUTPUT_FRAME_BYTES = 32 * 1024;
const OUTPUT_CREDIT_BYTES = 256 * 1024;
const FINAL_MARKER = 'ensoai-stage5-terminal-stress-final-marker';

type StressMetrics = {
  generated: number;
  delivered: number;
  acked: number;
  outstanding: number;
  maxOutstanding: number;
  maxOutputFrame: number;
  inputQueued: number;
  inputSent: number;
  maxInputFrame: number;
  maxBuffered: number;
  resizeObserved: number;
  resizeSent: number;
  pauses: number;
  resumes: number;
  markerCount: number;
  readyAt: number | null;
  markerAt: number | null;
  renderer: string | null;
};

async function signIn(page: Page): Promise<string> {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/auth/login' &&
    response.request().method() === 'POST',
  );
  await page.getByLabel('Username').fill(ALICE.username);
  await page.getByLabel('Password').fill(ALICE.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await responsePromise).json()) as { accessToken: string };
  return body.accessToken;
}

async function setScenario(
  page: Page,
  token: string,
  resource: 'run' | 'terminal',
  scenario: string,
): Promise<void> {
  const status = await page.evaluate(async ({ accessToken, kind, next }) => {
    const response = await fetch(`/api/v1/session/${kind}-scenario`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenario: next }),
    });
    return response.status;
  }, { accessToken: token, kind: resource, next: scenario });
  expect(status).toBe(204);
}

async function installStressHooks(page: Page): Promise<void> {
  await page.evaluate(({ generated, marker }) => {
    type Host = Window & {
      __stage5Stress?: StressMetrics;
      __stage5StressBuffered?: number | null;
    };
    const host = window as Host;
    host.__stage5Stress = {
      generated,
      delivered: 0,
      acked: 0,
      outstanding: 0,
      maxOutstanding: 0,
      maxOutputFrame: 0,
      inputQueued: 0,
      inputSent: 0,
      maxInputFrame: 0,
      maxBuffered: 0,
      resizeObserved: 0,
      resizeSent: 0,
      pauses: 0,
      resumes: 0,
      markerCount: 0,
      readyAt: null,
      markerAt: null,
      renderer: null,
    };
    host.__stage5StressBuffered = null;
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = new Proxy(NativeResizeObserver, {
      construct(target, args, newTarget) {
        const listener = args[0] as ResizeObserverCallback;
        return Reflect.construct(target, [(entries: ResizeObserverEntry[], observer: ResizeObserver) => {
          if (host.__stage5Stress !== undefined) host.__stage5Stress.resizeObserved += 1;
          listener(entries, observer);
        }], newTarget) as ResizeObserver;
      },
    });
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        if (new URL(String(args[0])).pathname !== '/api/v1/ws/terminals') return socket;
        const originalSend = socket.send.bind(socket);
        Object.defineProperty(socket, 'send', {
          configurable: true,
          value(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            const metrics = host.__stage5Stress;
            if (metrics !== undefined) {
              if (typeof data === 'string') {
                try {
                  const frame = JSON.parse(data) as { type?: string; bytes?: number };
                  if (frame.type === 'terminal.output.ack') {
                    metrics.acked += frame.bytes ?? 0;
                    metrics.outstanding -= frame.bytes ?? 0;
                  } else if (frame.type === 'terminal.resize') {
                    metrics.resizeSent += 1;
                  }
                } catch {
                  // Invalid control frames are asserted by the application protocol.
                }
              } else {
                const bytes = data instanceof Blob
                  ? data.size
                  : ArrayBuffer.isView(data)
                    ? data.byteLength
                    : data.byteLength;
                metrics.inputSent += bytes;
                metrics.maxInputFrame = Math.max(metrics.maxInputFrame, bytes);
              }
            }
            originalSend(data);
          },
        });
        socket.addEventListener('message', (event) => {
          const metrics = host.__stage5Stress;
          if (metrics === undefined) return;
          if (typeof event.data === 'string') {
            try {
              const frame = JSON.parse(event.data) as { type?: string };
              if (frame.type === 'terminal.ready') metrics.readyAt = performance.now();
              else if (frame.type === 'terminal.input.pause') metrics.pauses += 1;
              else if (frame.type === 'terminal.input.resume') metrics.resumes += 1;
            } catch {
              // Invalid controls fail in the application before evidence is accepted.
            }
            return;
          }
          if (!(event.data instanceof ArrayBuffer)) return;
          const bytes = event.data.byteLength;
          metrics.delivered += bytes;
          metrics.outstanding += bytes;
          metrics.maxOutstanding = Math.max(metrics.maxOutstanding, metrics.outstanding);
          metrics.maxOutputFrame = Math.max(metrics.maxOutputFrame, bytes);
          const text = new TextDecoder().decode(event.data);
          const count = text.split(marker).length - 1;
          if (count > 0) {
            metrics.markerCount += count;
            metrics.markerAt = performance.now();
          }
        });
        return new Proxy(socket, {
          get(targetSocket, property) {
            if (property === 'bufferedAmount') {
              const value = host.__stage5StressBuffered ?? targetSocket.bufferedAmount;
              if (host.__stage5Stress !== undefined) {
                host.__stage5Stress.maxBuffered = Math.max(host.__stage5Stress.maxBuffered, value);
              }
              return value;
            }
            const value = Reflect.get(targetSocket, property, targetSocket) as unknown;
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(targetSocket)
              : value;
          },
          set(targetSocket, property, value) {
            return Reflect.set(targetSocket, property, value, targetSocket);
          },
        });
      },
    });
  }, { generated: OUTPUT_BYTES + new TextEncoder().encode(FINAL_MARKER).byteLength, marker: FINAL_MARKER });
}

async function metrics(page: Page): Promise<StressMetrics> {
  return page.evaluate(() => {
    const value = (window as Window & { __stage5Stress?: StressMetrics }).__stage5Stress;
    if (value === undefined) throw new Error('stress metrics missing');
    const renderer = document.querySelector('[aria-label="Terminal renderer"]')?.textContent ?? null;
    return structuredClone({ ...value, renderer });
  });
}

test('streams at least 8 MiB with bounded terminal flow control and remains responsive', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/login');
  const token = await signIn(page);
  await page.getByRole('article', { name: 'Alice Notebook' })
    .getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}$`));
  await expect(page.getByRole('treeitem', { name: '.gitignore', exact: true })).toBeVisible();
  await installStressHooks(page);
  await setScenario(page, token, 'run', 'disconnect');
  await setScenario(page, token, 'terminal', 'stress');
  await page.getByRole('tab', { name: 'Run' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Run state')).toHaveText('RUNNING');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText(/Ready|Input paused/);
  await expect.poll(async () => {
    const current = await metrics(page);
    return { pauses: current.pauses, resumes: current.resumes };
  }).toEqual({ pauses: 1, resumes: 1 });
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready');

  const burst = `stress-input-${'i'.repeat(128 * 1024)}`;
  await page.evaluate((queued) => {
    const host = window as Window & { __stage5Stress?: StressMetrics; __stage5StressBuffered?: number | null };
    if (host.__stage5Stress !== undefined) host.__stage5Stress.inputQueued = queued;
    host.__stage5StressBuffered = 300 * 1024;
  }, burst.length);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText(burst);
  await expect.poll(async () => (await metrics(page)).maxBuffered).toBe(300 * 1024);
  await page.evaluate(() => {
    (window as Window & { __stage5StressBuffered?: number | null }).__stage5StressBuffered = 0;
  });
  await expect.poll(async () => (await metrics(page)).inputSent).toBe(burst.length);

  const resizeSentBeforeStorm = (await metrics(page)).resizeSent;
  const viewportBeforeStorm = page.viewportSize();
  if (viewportBeforeStorm === null) throw new Error('stress viewport missing');
  const firstStormWidth = viewportBeforeStorm.width === 1180 ? 1480 : 1180;
  const secondStormWidth = firstStormWidth === 1180 ? 1480 : 1180;
  for (let index = 0; index < 101; index += 1) {
    await page.setViewportSize({
      width: index % 2 === 0 ? firstStormWidth : secondStormWidth,
      height: 760,
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await expect.poll(async () => (await metrics(page)).resizeObserved, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(100);
  await expect.poll(async () => (await metrics(page)).resizeSent, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(resizeSentBeforeStorm + 100);
  await expect.poll(async () => (await metrics(page)).markerCount, { timeout: 120_000 }).toBe(1);

  const responsivenessStarted = Date.now();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const responsivenessMs = Date.now() - responsivenessStarted;
  const final = await metrics(page);
  expect(final.generated).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  expect(final.delivered).toBe(final.generated);
  expect(final.acked).toBe(final.delivered);
  expect(final.outstanding).toBe(0);
  expect(final.maxOutstanding).toBeLessThanOrEqual(OUTPUT_CREDIT_BYTES);
  expect(final.maxOutputFrame).toBeLessThanOrEqual(OUTPUT_FRAME_BYTES);
  expect(final.inputQueued).toBe(final.inputSent);
  expect(final.maxInputFrame).toBeLessThanOrEqual(16 * 1024);
  expect(final.resizeObserved).toBeGreaterThanOrEqual(100);
  expect(final.resizeSent).toBeGreaterThanOrEqual(100);
  expect(final.pauses).toBeGreaterThanOrEqual(1);
  expect(final.resumes).toBeGreaterThanOrEqual(1);
  expect(final.readyAt).toEqual(expect.any(Number));
  expect(final.markerAt).toEqual(expect.any(Number));
  expect(final.markerAt!).toBeGreaterThanOrEqual(final.readyAt!);
  expect(['WebGL', 'DOM fallback']).toContain(final.renderer);
  expect(responsivenessMs).toBeLessThan(5_000);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('region', { name: 'Run logs' })).not.toContainText(FINAL_MARKER);
  console.log('STAGE5_TERMINAL_STRESS_METRICS', JSON.stringify({
    ...final,
    responsivenessMs,
    consoleErrors,
    pageErrors,
  }));
});
