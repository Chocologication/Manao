import { expect, test, type Locator, type Page, type Request, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const MAX_RETAINED = 5 * 1024 * 1024;
const MIN_GENERATED = MAX_RETAINED + 1024 * 1024;
const HEAD_MARKER = 'ensoai-stage4-large-log-head';
const EVICTED_EARLY_MARKER = 'ensoai-stage4-large-log-evicted-early';
const LATEST_MARKER = 'ensoai-stage4-large-log-latest';
const WHILE_DISCONNECTED_MARKER = 'ensoai-stage4-large-log-while-disconnected';
const CHUNK_INDEX_PREFIX = 'ensoai-stage4-large-log-chunk-';

test.describe.configure({ timeout: 180_000 });

type ClientHooks = {
  wsUrls: string[];
  wsFrames: string[];
  closeCodes: number[];
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as {
      __e2eFetchHooks: { wsUrls: string[]; wsFrames: string[]; closeCodes: number[] };
      __e2eFetchWrapped?: boolean;
    };
    if (host.__e2eFetchHooks === undefined) {
      host.__e2eFetchHooks = { wsUrls: [], wsFrames: [], closeCodes: [] };
    }
    if (host.__e2eFetchWrapped === true) {
      return;
    }
    host.__e2eFetchWrapped = true;
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        host.__e2eFetchHooks.wsUrls.push(String(args[0]));
        socket.addEventListener('message', (event) => {
          const data = event.data;
          if (typeof data === 'string') {
            host.__e2eFetchHooks.wsFrames.push(data);
            return;
          }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void data.text().then((text) => {
              host.__e2eFetchHooks.wsFrames.push(text);
            });
            return;
          }
          if (data instanceof ArrayBuffer) {
            host.__e2eFetchHooks.wsFrames.push(new TextDecoder().decode(data));
            return;
          }
          host.__e2eFetchHooks.wsFrames.push(String(data));
        });
        socket.addEventListener('close', (event) => {
          host.__e2eFetchHooks.closeCodes.push((event as CloseEvent).code);
        });
        return socket;
      },
    });
  });
});

async function readClientHooks(page: Page): Promise<ClientHooks> {
  return page.evaluate(() => {
    const hooks = (
      window as unknown as {
        __e2eFetchHooks?: { wsUrls?: string[]; wsFrames?: string[]; closeCodes?: number[] };
      }
    ).__e2eFetchHooks;
    return {
      wsUrls: [...(hooks?.wsUrls ?? [])],
      wsFrames: [...(hooks?.wsFrames ?? [])],
      closeCodes: [...(hooks?.closeCodes ?? [])],
    };
  });
}

async function wrapPageWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as {
      __e2eFetchHooks: { wsUrls: string[]; wsFrames: string[]; closeCodes: number[] };
    };
    if (host.__e2eFetchHooks === undefined) {
      host.__e2eFetchHooks = { wsUrls: [], wsFrames: [], closeCodes: [] };
    }
    if (host.__e2eFetchHooks.closeCodes === undefined) {
      host.__e2eFetchHooks.closeCodes = [];
    }
    const CurrentWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(CurrentWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        host.__e2eFetchHooks.wsUrls.push(String(args[0]));
        socket.addEventListener('message', (event) => {
          const data = event.data;
          if (typeof data === 'string') {
            host.__e2eFetchHooks.wsFrames.push(data);
            return;
          }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void data.text().then((text) => {
              host.__e2eFetchHooks.wsFrames.push(text);
            });
            return;
          }
          if (data instanceof ArrayBuffer) {
            host.__e2eFetchHooks.wsFrames.push(new TextDecoder().decode(data));
            return;
          }
          host.__e2eFetchHooks.wsFrames.push(String(data));
        });
        socket.addEventListener('close', (event) => {
          host.__e2eFetchHooks.closeCodes.push((event as CloseEvent).code);
        });
        return socket;
      },
    });
  });
}

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

function treeItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function parseProjectFileApi(url: string): { path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/api\/v1\/projects\/[^/]+\/files\/(tree|meta|content)$/);
  if (match === null) {
    return null;
  }
  return { path: parsed.searchParams.get('path') ?? '' };
}

function waitForFileApi(page: Page, path: string, status = 200): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseProjectFileApi(response.url());
    return (
      parsed !== null &&
      parsed.path === path &&
      response.request().method() === 'GET' &&
      response.status() === status
    );
  });
}

function isStartRunPost(request: Request): boolean {
  if (request.method() !== 'POST') {
    return false;
  }
  try {
    return /^\/api\/v1\/projects\/[^/]+\/runs$/.test(new URL(request.url()).pathname);
  } catch {
    return false;
  }
}

function isForbiddenStage4Url(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return /\/terminal(?:\?|\/|$)/.test(url);
  }
  if (/\/terminal(?:\/|$)/.test(parsed.pathname)) {
    return true;
  }
  if (parsed.port === '4174' && parsed.pathname !== '/health') {
    return true;
  }
  return false;
}

async function signIn(page: Page): Promise<string> {
  const loginResponse = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return pathname === '/api/v1/auth/login' && response.request().method() === 'POST';
  });
  await page.getByLabel('Username').fill(ALICE.username);
  await page.getByLabel('Password').fill(ALICE.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await loginResponse).json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  expect(body.accessToken?.length).toBeGreaterThan(0);
  return body.accessToken as string;
}

async function openAliceWorkbench(page: Page): Promise<string> {
  await page.goto('/login');
  const accessToken = await signIn(page);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await rootTree;
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  return accessToken;
}

async function setRunScenario(page: Page, accessToken: string, scenario: string): Promise<void> {
  const status = await page.evaluate(async ({ token, next }) => {
    const response = await fetch('/api/v1/session/run-scenario', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenario: next }),
    });
    return response.status;
  }, { token: accessToken, next: scenario });
  expect(status).toBe(204);
}

function collectPageIssues(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('crash', () => {
    pageErrors.push('page crashed');
  });
  return { consoleErrors, pageErrors };
}

type LogWindowMeta = {
  firstAvailableSeq: number | null;
  lastAvailableSeq: number | null;
  retainedBytes: number;
  truncated: boolean;
  evictedBytes: number;
};

type StreamStats = {
  generatedBytes: number;
  retainedBytes: number;
  evictedBytes: number;
  frameCount: number;
  firstAvailableSeq: number | null;
  lastAvailableSeq: number | null;
  ticketUrls: string[];
  wsUrls: string[];
  startBodies: unknown[];
  forbidden: string[];
  firstWsClosedAt: number | null;
  generatedReadyAt: number | null;
  completeCount: number;
  streamUnavailableCount: number;
};

type ParsedChunk = { seq?: number; byteLength?: number; text?: string };

function chunkUtf8Bytes(chunk: ParsedChunk): number | null {
  if (typeof chunk.text === 'string') {
    return Buffer.byteLength(chunk.text, 'utf8');
  }
  return null;
}

function payloadToUtf8(payload: string | Buffer): string {
  return typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
}

function ingestFrame(
  stats: StreamStats,
  bytesBySeq: Map<number, number>,
  seen: Set<string>,
  raw: string,
): void {
  if (seen.has(raw)) {
    return;
  }
  let parsed: {
    type?: string;
    chunk?: ParsedChunk;
    chunks?: ParsedChunk[];
    window?: LogWindowMeta;
    code?: string;
    lastSeq?: number | null;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return;
  }
  seen.add(raw);
  stats.frameCount += 1;
  if (parsed.type === 'log.complete') {
    stats.completeCount += 1;
  }
  if (parsed.type === 'stream.error' && parsed.code === 'STREAM_UNAVAILABLE') {
    stats.streamUnavailableCount += 1;
    if (stats.firstWsClosedAt === null) {
      stats.firstWsClosedAt = Date.now();
    }
  }
  if (parsed.type === 'log.replay') {
    for (const chunk of parsed.chunks ?? []) {
      const bytes = chunkUtf8Bytes(chunk);
      if (typeof chunk.seq === 'number' && bytes !== null) {
        bytesBySeq.set(chunk.seq, bytes);
      }
    }
  }
  if (parsed.type === 'log.append' && parsed.chunk !== undefined) {
    const bytes = chunkUtf8Bytes(parsed.chunk);
    if (typeof parsed.chunk.seq === 'number' && bytes !== null) {
      bytesBySeq.set(parsed.chunk.seq, bytes);
    }
  }
  if (parsed.window !== undefined) {
    stats.retainedBytes = parsed.window.retainedBytes;
    stats.evictedBytes = parsed.window.evictedBytes;
    stats.firstAvailableSeq = parsed.window.firstAvailableSeq;
    stats.lastAvailableSeq = parsed.window.lastAvailableSeq;
  }
  stats.generatedBytes = [...bytesBySeq.values()].reduce((total, value) => total + value, 0);
  if (stats.generatedBytes >= MIN_GENERATED && stats.generatedReadyAt === null) {
    stats.generatedReadyAt = Date.now();
  }
}

function rememberWsUrl(stats: StreamStats, url: string): void {
  if (!stats.wsUrls.includes(url) && /\/api\/v1\/ws\/run-logs/.test(url)) {
    stats.wsUrls.push(url);
  }
}

function installLargeLogObserver(page: Page): {
  stats: StreamStats;
  bytesBySeq: Map<number, number>;
  seen: Set<string>;
  frames: string[];
} {
  const stats: StreamStats = {
    generatedBytes: 0,
    retainedBytes: 0,
    evictedBytes: 0,
    frameCount: 0,
    firstAvailableSeq: null,
    lastAvailableSeq: null,
    ticketUrls: [],
    wsUrls: [],
    startBodies: [],
    forbidden: [],
    firstWsClosedAt: null,
    generatedReadyAt: null,
    completeCount: 0,
    streamUnavailableCount: 0,
  };
  const bytesBySeq = new Map<number, number>();
  const seen = new Set<string>();
  const frames: string[] = [];

  page.on('request', (request) => {
    if (isForbiddenStage4Url(request.url())) {
      stats.forbidden.push(`${request.method()} ${request.url()}`);
    }
    if (isStartRunPost(request)) {
      stats.startBodies.push(JSON.parse(request.postData() ?? '{}'));
    }
    if (request.url().includes('/log-ticket')) {
      stats.ticketUrls.push(request.url());
    }
    rememberWsUrl(stats, request.url());
  });

  page.on('websocket', (ws) => {
    rememberWsUrl(stats, ws.url());
    ws.on('framereceived', (event) => {
      const raw = payloadToUtf8(event.payload);
      frames.push(raw);
      ingestFrame(stats, bytesBySeq, seen, raw);
    });
    ws.on('close', () => {
      if (stats.firstWsClosedAt === null) {
        stats.firstWsClosedAt = Date.now();
      }
    });
  });

  return { stats, bytesBySeq, seen, frames };
}

function applyFramesToStats(
  stats: StreamStats,
  bytesBySeq: Map<number, number>,
  seen: Set<string>,
  frames: string[],
  wsUrls: string[],
): void {
  for (const url of wsUrls) {
    rememberWsUrl(stats, url);
  }
  for (const raw of frames) {
    ingestFrame(stats, bytesBySeq, seen, raw);
  }
}

function replayAfterDisconnectHasNewSeq(frames: string[]): boolean {
  let sawUnavailable = false;
  const seqsBefore = new Set<number>();
  for (const raw of frames) {
    let parsed: {
      type?: string;
      code?: string;
      chunk?: { seq?: number; text?: string };
      chunks?: Array<{ seq?: number; text?: string }>;
    };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      continue;
    }
    if (!sawUnavailable) {
      if (parsed.type === 'log.append' && typeof parsed.chunk?.seq === 'number') {
        seqsBefore.add(parsed.chunk.seq);
      }
      if (parsed.type === 'log.replay') {
        for (const chunk of parsed.chunks ?? []) {
          if (typeof chunk.seq === 'number') {
            seqsBefore.add(chunk.seq);
          }
        }
      }
      if (parsed.type === 'stream.error' && parsed.code === 'STREAM_UNAVAILABLE') {
        sawUnavailable = true;
      }
      continue;
    }
    if (parsed.type === 'log.replay') {
      const hasNewSeq = (parsed.chunks ?? []).some(
        (chunk) => typeof chunk.seq === 'number' && !seqsBefore.has(chunk.seq),
      );
      const hasWhileDisconnected = (parsed.chunks ?? []).some((chunk) =>
        (chunk.text ?? '').includes(WHILE_DISCONNECTED_MARKER),
      );
      if (hasNewSeq && hasWhileDisconnected) {
        return true;
      }
    }
  }
  return false;
}

async function recordMeasurement(
  title: string,
  measurement: Record<string, unknown>,
): Promise<void> {
  const payload = { title, ...measurement };
  console.log(`LARGE_LOG_MEASUREMENT ${JSON.stringify(payload)}`);
  await test.info().attach('large-log-measurement', {
    body: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
}

function countMarker(text: string, marker: string): number {
  if (marker.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(marker, from);
    if (index < 0) {
      return count;
    }
    count += 1;
    from = index + marker.length;
  }
  return count;
}

test('streams more than 6 MiB, keeps a 5 MiB window, reconnects, and stays responsive', async ({
  page,
}) => {
  const issues = collectPageIssues(page);
  const accessToken = await openAliceWorkbench(page);
  await wrapPageWebSocket(page);
  const { stats, bytesBySeq, seen, frames } = installLargeLogObserver(page);
  await setRunScenario(page, accessToken, 'large-log');
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();

  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Log connection')).toHaveText('Live', { timeout: 20_000 });
  const readyMs = Date.now() - startedAt;
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();

  await expect(page.getByLabel('Log truncation')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByLabel('Log truncation')).toContainText(/Log truncated/);
  const log = page.getByRole('region', { name: 'Run logs' });
  await expect(log).toContainText(LATEST_MARKER, { timeout: 60_000 });
  await expect(log).not.toContainText(HEAD_MARKER);
  await expect(log).not.toContainText(EVICTED_EARLY_MARKER);

  const logText = await log.innerText();
  expect(countMarker(logText, LATEST_MARKER)).toBe(1);
  expect(countMarker(logText, HEAD_MARKER)).toBe(0);
  expect(countMarker(logText, EVICTED_EARLY_MARKER)).toBe(0);
  const indexMatches = logText.match(new RegExp(`${CHUNK_INDEX_PREFIX}\\d{6}`, 'g')) ?? [];
  expect(new Set(indexMatches).size).toBe(indexMatches.length);

  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      applyFramesToStats(stats, bytesBySeq, seen, hooks.wsFrames, hooks.wsUrls);
      return stats.generatedBytes;
    }, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(MIN_GENERATED);
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      applyFramesToStats(stats, bytesBySeq, seen, hooks.wsFrames, hooks.wsUrls);
      return (
        (hooks.closeCodes.includes(1011) || stats.streamUnavailableCount > 0) &&
        replayAfterDisconnectHasNewSeq([...frames, ...hooks.wsFrames])
      );
    }, { timeout: 60_000 })
    .toBe(true);
  expect(stats.firstWsClosedAt).not.toBeNull();
  expect(stats.generatedReadyAt).not.toBeNull();
  const reconnectCatchUpMs = Math.max(
    0,
    (stats.generatedReadyAt as number) - (stats.firstWsClosedAt as number),
  );
  expect(stats.retainedBytes).toBeGreaterThan(0);
  expect(stats.retainedBytes).toBeLessThanOrEqual(MAX_RETAINED);
  expect(stats.evictedBytes).toBeGreaterThan(0);
  expect(stats.firstAvailableSeq).not.toBeNull();
  expect(stats.lastAvailableSeq).not.toBeNull();
  expect(stats.firstAvailableSeq ?? 0).toBeGreaterThan(1);
  expect(stats.lastAvailableSeq ?? 0).toBeGreaterThan(stats.firstAvailableSeq ?? 0);
  expect(stats.ticketUrls.length).toBeGreaterThanOrEqual(2);
  expect(stats.wsUrls.length).toBeGreaterThanOrEqual(2);
  for (const url of stats.wsUrls) {
    expect(url).not.toContain(accessToken);
    expect(url).not.toMatch(/accessToken|Bearer |eyJ/);
    expect(url).toMatch(/\/api\/v1\/ws\/run-logs\?ticket=/);
  }
  expect(stats.startBodies).toHaveLength(1);
  const startBody = stats.startBodies[0] as Record<string, unknown>;
  expect(Object.keys(startBody)).toEqual(['expectedWorkspaceRevision']);
  expect(startBody.command).toBeUndefined();
  expect(startBody.image).toBeUndefined();
  expect(startBody.resources).toBeUndefined();
  expect(stats.forbidden).toEqual([]);

  await expect
    .poll(async () => {
      return log.evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
      });
    })
    .toBe(true);

  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'New output' })).toBeVisible();
  await page.getByRole('button', { name: 'New output' }).click();
  await expect(page.getByRole('button', { name: 'New output' })).toHaveCount(0);
  await expect
    .poll(async () => {
      return log.evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
      });
    })
    .toBe(true);

  const probeStarted = Date.now();
  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  await expect(log).toContainText(LATEST_MARKER);
  const probeMs = Date.now() - probeStarted;
  expect(probeMs).toBeLessThan(5_000);

  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      applyFramesToStats(stats, bytesBySeq, seen, hooks.wsFrames, hooks.wsUrls);
      return stats.completeCount;
    }, { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect(page.getByLabel('Run state')).toHaveText(/SUCCEEDED|Reloading workspace/, {
    timeout: 60_000,
  });
  await expect(page.getByLabel('Run state')).not.toHaveText(/^RUNNING$/);

  expect(issues.pageErrors).toEqual([]);
  const unexpectedConsole = issues.consoleErrors.filter(
    (item) => !/failed to load resource/i.test(item),
  );
  expect(unexpectedConsole).toEqual([]);

  await recordMeasurement('stage4-large-log', {
    generatedBytes: stats.generatedBytes,
    retainedBytes: stats.retainedBytes,
    evictedBytes: stats.evictedBytes,
    frameCount: stats.frameCount,
    firstAvailableSeq: stats.firstAvailableSeq,
    lastAvailableSeq: stats.lastAvailableSeq,
    readyMs,
    reconnectCatchUpMs,
    probeMs,
    ticketCount: stats.ticketUrls.length,
    wsCount: stats.wsUrls.length,
    completeCount: stats.completeCount,
    streamUnavailableCount: stats.streamUnavailableCount,
    consoleErrors: issues.consoleErrors,
    pageErrors: issues.pageErrors,
  });
});
