import { inflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page, type Request, type Response } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_SEED_PROJECT_ID = 'prj-alice-notebook';
const BOB_SEED_PROJECT_ID = 'prj-bob-lab';
const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';
const SEED_LOG_MARKER = 'ensoai-stage4-seed-log';
const GAP_DUP_MARKER = 'ensoai-stage4-gap-dup';
const GAP_SKIPPED_MARKER = 'ensoai-stage4-gap-skipped';
const GAP_VISIBLE_MARKER = 'ensoai-stage4-gap-visible';
const PERSISTED_OFFLINE_MARKER = 'ensoai-stage4-persisted-offline';
const RECONNECT_LIVE_MARKER = 'ensoai-stage4-reconnect-live';
const STALE_SOCKET_MARKER = 'ensoai-stage4-stale-socket';
const RELOAD_MARKER = 'ensoai-stage4-reload-change';
const HEAD_MARKER = 'ensoai-stage4-large-log-head';
const EVICTED_EARLY_MARKER = 'ensoai-stage4-large-log-evicted-early';
const LATEST_MARKER = 'ensoai-stage4-large-log-latest';

const viewports = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

type FileResource = 'tree' | 'meta' | 'content';
type WriteScenario = 'normal' | 'delayed' | 'locked' | 'conflict' | 'failure';
type RunScenario =
  | 'success'
  | 'failure'
  | 'timeout'
  | 'recovery'
  | 'delayed-start'
  | 'gap'
  | 'disconnect'
  | 'large-log'
  | 'reload-change';

function projectCard(page: Page, name: string): Locator {
  return page.getByRole('article', { name });
}

function treeItem(page: Page, name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function editorTab(page: Page, name: RegExp): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name });
}

function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Save', exact: true });
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseProjectFileApi(url: string): { resource: FileResource; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = parsed.pathname.match(/^\/api\/v1\/projects\/[^/]+\/files\/(tree|meta|content)$/);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return {
    resource: match[1] as FileResource,
    path: parsed.searchParams.get('path') ?? '',
  };
}

function waitForFileApi(
  page: Page,
  resource: FileResource,
  path: string,
  status = 200,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseProjectFileApi(response.url());
    return (
      parsed !== null &&
      parsed.resource === resource &&
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

function paethPredictor(left: number, up: number, upLeft: number): number {
  const payload = left + up - upLeft;
  const pa = Math.abs(payload - left);
  const pb = Math.abs(payload - up);
  const pc = Math.abs(payload - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  if (pb <= pc) {
    return up;
  }
  return upLeft;
}

function unfilterPngRow(
  filter: number,
  source: Uint8Array,
  destination: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
): void {
  for (let index = 0; index < source.length; index += 1) {
    const sample = source[index] ?? 0;
    const left = index >= bytesPerPixel ? (destination[index - bytesPerPixel] ?? 0) : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0;
    let value = sample;
    if (filter === 1) {
      value = (sample + left) & 0xff;
    } else if (filter === 2) {
      value = (sample + up) & 0xff;
    } else if (filter === 3) {
      value = (sample + Math.floor((left + up) / 2)) & 0xff;
    } else if (filter === 4) {
      value = (sample + paethPredictor(left, up, upLeft)) & 0xff;
    } else if (filter !== 0) {
      throw new Error(`unsupported png filter ${filter}`);
    }
    destination[index] = value;
  }
}

function pngHasNonBackgroundText(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) {
      throw new Error('not a png');
    }
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16] ?? 0;
      colorType = bytes[offset + 17] ?? 0;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || width < 2 || height < 2) {
    return false;
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * bytesPerPixel;
  const counts = new Map<string, number>();
  let source = 0;
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[source] ?? 0;
    source += 1;
    const raw = inflated.subarray(source, source + stride);
    source += stride;
    const current = new Uint8Array(stride);
    unfilterPngRow(filter, raw, current, previous, bytesPerPixel);
    previous = current;
    for (let column = 0; column < width; column += 4) {
      const index = column * bytesPerPixel;
      const alpha = bytesPerPixel === 4 ? (current[index + 3] ?? 0) : 255;
      if (alpha === 0) {
        continue;
      }
      const key = `${current[index]},${current[index + 1]},${current[index + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts.size >= 2;
}

type SocketTrace = {
  url: string;
  frames: string[];
  closeCode: number | null;
};

type ClientHooks = {
  holdActive: boolean;
  holdRootTree: boolean;
  holdContentPut: boolean;
  failNextRootTree: boolean;
  abortNextStart: boolean;
  wsUrls: string[];
  wsFrames: string[];
  closeCodes: number[];
  socketTraces: SocketTrace[];
};

type ParsedLogFrame = {
  type?: string;
  chunk?: { seq?: number; text?: string; byteLength?: number };
  chunks?: Array<{ seq?: number; text?: string; byteLength?: number }>;
  window?: {
    firstAvailableSeq?: number | null;
    lastAvailableSeq?: number | null;
    retainedBytes?: number;
    truncated?: boolean;
    evictedBytes?: number;
  };
  code?: string;
  retryable?: boolean;
  lastSeq?: number | null;
};

function parseLogFrame(raw: string): ParsedLogFrame | null {
  try {
    return JSON.parse(raw) as ParsedLogFrame;
  } catch {
    return null;
  }
}

async function readClientHooks(page: Page): Promise<ClientHooks> {
  return page.evaluate(() => {
    const hooks = (
      window as unknown as {
        __e2eFetchHooks?: ClientHooks;
      }
    ).__e2eFetchHooks;
    return {
      holdActive: hooks?.holdActive === true,
      holdRootTree: hooks?.holdRootTree === true,
      holdContentPut: hooks?.holdContentPut === true,
      failNextRootTree: hooks?.failNextRootTree === true,
      abortNextStart: hooks?.abortNextStart === true,
      wsUrls: [...(hooks?.wsUrls ?? [])],
      wsFrames: [...(hooks?.wsFrames ?? [])],
      closeCodes: [...(hooks?.closeCodes ?? [])],
      socketTraces: (hooks?.socketTraces ?? []).map((trace) => ({
        url: trace.url,
        frames: [...trace.frames],
        closeCode: trace.closeCode,
      })),
    };
  });
}

function lastAppliedSeqFromFrames(frames: string[]): number | null {
  let last: number | null = null;
  for (const raw of frames) {
    const parsed = parseLogFrame(raw);
    if (parsed === null) {
      continue;
    }
    if (parsed.type === 'log.replay') {
      for (const chunk of parsed.chunks ?? []) {
        if (typeof chunk.seq === 'number') {
          last = last === null ? chunk.seq : Math.max(last, chunk.seq);
        }
      }
    }
    if (parsed.type === 'log.append' && typeof parsed.chunk?.seq === 'number') {
      last = last === null ? parsed.chunk.seq : Math.max(last, parsed.chunk.seq);
    }
    if (typeof parsed.window?.lastAvailableSeq === 'number') {
      last = last === null ? parsed.window.lastAvailableSeq : Math.max(last, parsed.window.lastAvailableSeq);
    }
  }
  return last;
}

function distinctRunLogUrls(traces: SocketTrace[]): string[] {
  const urls: string[] = [];
  for (const trace of traces) {
    if (!/\/api\/v1\/ws\/run-logs/.test(trace.url) || urls.includes(trace.url)) {
      continue;
    }
    urls.push(trace.url);
  }
  return urls;
}

async function injectStaleLogAppend(
  page: Page,
  options: { marker: string; seq: number; socketIndex: number },
): Promise<void> {
  const injected = await page.evaluate((payload) => {
    const host = window as unknown as {
      __e2eFetchHooks?: { liveSockets?: WebSocket[] };
    };
    const sockets = host.__e2eFetchHooks?.liveSockets ?? [];
    const target = sockets[payload.socketIndex];
    const other = sockets.find((_, index) => index !== payload.socketIndex);
    if (target === undefined || other === undefined || target === other) {
      return false;
    }
    const bytes = new TextEncoder().encode(payload.text).byteLength;
    target.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({
          type: 'log.append',
          chunk: {
            seq: payload.seq,
            text: payload.text,
            byteLength: bytes,
            persistedAt: new Date().toISOString(),
          },
          window: {
            firstAvailableSeq: payload.seq,
            lastAvailableSeq: payload.seq,
            retainedBytes: bytes,
            truncated: false,
            evictedBytes: 0,
          },
        }),
      }),
    );
    return true;
  }, { marker: options.marker, seq: options.seq, socketIndex: options.socketIndex, text: `${options.marker}\n` });
  expect(injected).toBe(true);
}

function socketReplayBeforeAppend(trace: SocketTrace): boolean {
  let seenReplay = false;
  for (const raw of trace.frames) {
    const parsed = parseLogFrame(raw);
    if (parsed?.type === 'log.replay') {
      seenReplay = true;
    }
    if (parsed?.type === 'log.append' && !seenReplay) {
      return false;
    }
  }
  return seenReplay;
}

function replayChunkBodies(frames: string[]): string[][] {
  const bodies: string[][] = [];
  for (const raw of frames) {
    const parsed = parseLogFrame(raw);
    if (parsed?.type === 'log.replay') {
      bodies.push((parsed.chunks ?? []).map((chunk) => chunk.text ?? ''));
    }
  }
  return bodies;
}

function appendSeqCounts(frames: string[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const raw of frames) {
    const parsed = parseLogFrame(raw);
    if (parsed?.type === 'log.append' && typeof parsed.chunk?.seq === 'number') {
      counts.set(parsed.chunk.seq, (counts.get(parsed.chunk.seq) ?? 0) + 1);
    }
  }
  return counts;
}

function socketHasReplayThenLive(trace: SocketTrace): boolean {
  let seenReplay = false;
  let seenLiveAfterReplay = false;
  let lastReplaySeq: number | null = null;
  for (const raw of trace.frames) {
    const parsed = parseLogFrame(raw);
    if (parsed?.type === 'log.replay') {
      if (seenLiveAfterReplay) {
        return false;
      }
      seenReplay = true;
      for (const chunk of parsed.chunks ?? []) {
        if (typeof chunk.seq === 'number') {
          lastReplaySeq = lastReplaySeq === null ? chunk.seq : Math.max(lastReplaySeq, chunk.seq);
        }
      }
    }
    if (parsed?.type === 'log.append' && typeof parsed.chunk?.seq === 'number') {
      if (!seenReplay) {
        return false;
      }
      if (lastReplaySeq !== null && parsed.chunk.seq <= lastReplaySeq) {
        continue;
      }
      seenLiveAfterReplay = true;
    }
  }
  return seenReplay && seenLiveAfterReplay;
}

async function patchClientHooks(
  page: Page,
  patch: Partial<Omit<ClientHooks, 'wsUrls' | 'wsFrames' | 'closeCodes' | 'socketTraces'>>,
): Promise<void> {
  await page.evaluate((next) => {
    const host = window as unknown as {
      __e2eFetchHooks: ClientHooks & {
        activeResolvers: Array<() => void>;
        treeResolvers: Array<() => void>;
        writeResolvers: Array<() => void>;
      };
    };
    Object.assign(host.__e2eFetchHooks, next);
    if (next.holdActive === false) {
      for (const resolve of host.__e2eFetchHooks.activeResolvers.splice(0)) {
        resolve();
      }
    }
    if (next.holdRootTree === false) {
      for (const resolve of host.__e2eFetchHooks.treeResolvers.splice(0)) {
        resolve();
      }
    }
    if (next.holdContentPut === false) {
      for (const resolve of host.__e2eFetchHooks.writeResolvers.splice(0)) {
        resolve();
      }
    }
  }, patch);
}

function installStage4Guard(page: Page) {
  const forbidden: string[] = [];
  const startBodies: unknown[] = [];
  const ticketUrls: string[] = [];
  const startPosts: Request[] = [];
  page.on('request', (request) => {
    if (isForbiddenStage4Url(request.url())) {
      forbidden.push(`${request.method()} ${request.url()}`);
    }
    if (isStartRunPost(request)) {
      startPosts.push(request);
      startBodies.push(JSON.parse(request.postData() ?? '{}'));
    }
    if (request.url().includes('/log-ticket')) {
      ticketUrls.push(request.url());
    }
  });
  return { forbidden, startBodies, ticketUrls, startPosts };
}

async function signIn(
  page: Page,
  credentials: { username: string; password: string },
): Promise<string> {
  const loginResponse = page.waitForResponse((response) => {
    const { pathname } = new URL(response.url());
    return pathname === '/api/v1/auth/login' && response.request().method() === 'POST';
  });
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await loginResponse).json()) as { accessToken?: string };
  expect(typeof body.accessToken).toBe('string');
  expect(body.accessToken?.length).toBeGreaterThan(0);
  return body.accessToken as string;
}

async function wrapPageWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = window as unknown as {
      __e2eFetchHooks: {
        wsUrls: string[];
        wsFrames: string[];
        closeCodes: number[];
        socketTraces: SocketTrace[];
        liveSockets: WebSocket[];
        seenSockets: WeakSet<WebSocket>;
      };
      __e2eWsWrapped?: boolean;
    };
    if (host.__e2eFetchHooks.closeCodes === undefined) {
      host.__e2eFetchHooks.closeCodes = [];
    }
    if (host.__e2eFetchHooks.socketTraces === undefined) {
      host.__e2eFetchHooks.socketTraces = [];
    }
    if (host.__e2eFetchHooks.liveSockets === undefined) {
      host.__e2eFetchHooks.liveSockets = [];
    }
    if (host.__e2eFetchHooks.seenSockets === undefined) {
      host.__e2eFetchHooks.seenSockets = new WeakSet<WebSocket>();
    }
    if (host.__e2eWsWrapped === true) {
      return;
    }
    host.__e2eWsWrapped = true;
    const CurrentWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(CurrentWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        if (host.__e2eFetchHooks.seenSockets.has(socket)) {
          return socket;
        }
        host.__e2eFetchHooks.seenSockets.add(socket);
        const url = String(args[0]);
        const trace: SocketTrace = { url, frames: [], closeCode: null };
        host.__e2eFetchHooks.wsUrls.push(url);
        host.__e2eFetchHooks.socketTraces.push(trace);
        host.__e2eFetchHooks.liveSockets.push(socket);
        const recordFrame = (raw: string): void => {
          host.__e2eFetchHooks.wsFrames.push(raw);
          trace.frames.push(raw);
        };
        socket.addEventListener('message', (event) => {
          const data = event.data;
          if (typeof data === 'string') {
            recordFrame(data);
            return;
          }
          if (typeof Blob !== 'undefined' && data instanceof Blob) {
            void data.text().then((text) => {
              recordFrame(text);
            });
            return;
          }
          if (data instanceof ArrayBuffer) {
            recordFrame(new TextDecoder().decode(data));
          }
        });
        socket.addEventListener('close', (event) => {
          const code = (event as CloseEvent).code;
          trace.closeCode = code;
          host.__e2eFetchHooks.closeCodes.push(code);
        });
        return socket;
      },
    });
  });
}

async function openAliceWorkbench(
  page: Page,
): Promise<{ accessToken: string; workspaceRevision: string }> {
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  const treeResponse = await rootTree;
  const treeBody = (await treeResponse.json()) as { workspaceRevision?: string };
  expect(typeof treeBody.workspaceRevision).toBe('string');
  expect(treeBody.workspaceRevision?.length).toBeGreaterThan(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_SEED_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  await wrapPageWebSocket(page);
  return { accessToken, workspaceRevision: treeBody.workspaceRevision as string };
}

async function expandDirectory(page: Page, name: string, directoryPath: string): Promise<void> {
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  if ((await item.getAttribute('aria-expanded')) === 'true') {
    return;
  }
  const treeResponse = waitForFileApi(page, 'tree', directoryPath);
  await item.click();
  await treeResponse;
  await expect(item).toHaveAttribute('aria-expanded', 'true');
}

async function openFile(page: Page, name: string): Promise<void> {
  const item = treeItem(page, name);
  await expect(item).toBeVisible();
  await item.click();
  await expect(
    page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab', { name }),
  ).toBeVisible();
  await expect(page.locator('.monaco-editor').or(page.getByRole('textbox', { name }))).toBeVisible();
}

async function waitForMonacoText(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);
}

async function monacoValue(page: Page, pathFragment: string): Promise<string> {
  return page.evaluate((fragment) => {
    const monaco = (
      window as unknown as {
        monaco?: {
          editor?: { getModels?: () => Array<{ uri: { toString(): string }; getValue(): string }> };
        };
      }
    ).monaco;
    const match = monaco?.editor
      ?.getModels?.()
      .find((model) => model.uri.toString().includes(fragment));
    if (match === undefined) {
      throw new Error(`Monaco model missing: ${fragment}`);
    }
    return match.getValue();
  }, pathFragment);
}

async function typeInMonaco(page: Page, text: string): Promise<void> {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Editor content' });
  await expect(input).toBeAttached();
  await editor.click();
  await input.focus();
  await expect(input).toBeFocused();
  await page.keyboard.press('Control+End');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const visible = await page.locator('.monaco-editor .view-lines').innerText();
    if (visible.includes(text)) {
      return;
    }
    await page.keyboard.type(text, { delay: 20 });
  }
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(text);
}

async function setWriteScenario(
  page: Page,
  accessToken: string,
  scenario: WriteScenario,
): Promise<void> {
  const status = await page.evaluate(async ({ token, next }) => {
    const response = await fetch('/api/v1/session/write-scenario', {
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

async function setRunScenario(
  page: Page,
  accessToken: string,
  scenario: RunScenario,
): Promise<void> {
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

async function waitUntilWritable(page: Page, timeout = 45_000): Promise<void> {
  const newFile = page.getByRole('button', { name: 'New file' });
  await expect(newFile).toBeDisabled({ timeout: 10_000 });
  await expect
    .poll(async () => {
      const retry = page.getByRole('button', { name: 'Retry workspace reload' });
      if ((await retry.count()) > 0) {
        try {
          await retry.click({ timeout: 1_000 });
        } catch {
          // Retry disappeared between count and click.
        }
      }
      return newFile.isEnabled();
    }, { timeout })
    .toBe(true);
}

async function openRunPanel(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('toolbar', { name: 'Run controls' })).toBeVisible();
}

async function openFilePanel(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.getByRole('tab', { name: 'File' })).toHaveAttribute('aria-selected', 'true');
}

async function prepareVisualCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.head.querySelector('style[data-e2e-visual]')) {
      return;
    }
    const style = document.createElement('style');
    style.setAttribute('data-e2e-visual', '');
    style.textContent = [
      '*, *::before, *::after {',
      '  animation: none !important;',
      '  animation-duration: 0s !important;',
      '  transition: none !important;',
      '  caret-color: transparent !important;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      root: root.scrollWidth > root.clientWidth + 1,
      body: body.scrollWidth > body.clientWidth + 1,
    };
  });
  expect(overflow.root).toBe(false);
  expect(overflow.body).toBe(false);
}

async function assertReachable(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  const viewport = locator.page().viewportSize();
  expect(viewport).not.toBeNull();
  if (viewport === null) {
    return;
  }
  expect(box.x).toBeLessThan(viewport.width);
  expect(box.y).toBeLessThan(viewport.height);
  expect(box.x + box.width).toBeGreaterThan(0);
  expect(box.y + box.height).toBeGreaterThan(0);
}

async function assertInsideViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = locator.page().viewportSize();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) {
    return;
  }
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function assertRunGeometry(page: Page): Promise<void> {
  const headerBox = await page.locator('.workbench-shell > header').boundingBox();
  const sidebarBox = await page.getByRole('complementary', { name: 'Project files' }).boundingBox();
  const historyBox = await page.getByRole('complementary', { name: 'Recent runs' }).boundingBox();
  const logBox = await page.getByRole('region', { name: 'Run logs' }).boundingBox();
  expect(headerBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect(historyBox).not.toBeNull();
  expect(logBox).not.toBeNull();
  if (headerBox === null || sidebarBox === null || historyBox === null || logBox === null) {
    return;
  }
  expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(sidebarBox.y + 1);
  expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(historyBox.x + 2);
  expect(historyBox.x + historyBox.width).toBeLessThanOrEqual(logBox.x + 2);
}

async function captureViewport(
  page: Page,
  filePath: string,
  viewport: { width: number; height: number },
): Promise<void> {
  const bytes = await page.screenshot({
    path: filePath,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
  });
  expect(pngSize(bytes)).toEqual({ width: viewport.width, height: viewport.height });
}

async function assertFocusVisible(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      return locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const opacity = Number(style.opacity);
        if (style.visibility === 'hidden' || !(opacity > 0)) {
          return false;
        }
        const inViewport =
          rect.width > 1 &&
          rect.height > 1 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth;
        if (!inViewport) {
          return false;
        }
        const outlineWidth = Number.parseFloat(style.outlineWidth);
        const hasOutline =
          style.outlineStyle !== 'none' &&
          style.outlineStyle !== '' &&
          Number.isFinite(outlineWidth) &&
          outlineWidth > 0;
        const shadow = style.boxShadow.trim();
        const hasRing = shadow !== '' && shadow !== 'none';
        return hasOutline || hasRing;
      });
    })
    .toBe(true);
}

async function tabUntilFocused(page: Page, locator: Locator, maxTabs = 80): Promise<void> {
  if (await locator.evaluate((element) => element === document.activeElement)) {
    return;
  }
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    await page.keyboard.press('Shift+Tab');
    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  await expect(locator).toBeFocused();
}

async function triggerSessionRefetch(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

function assertStartBody(body: unknown, workspaceRevision: string): void {
  expect(body).toEqual({ expectedWorkspaceRevision: workspaceRevision });
  const record = body as Record<string, unknown>;
  expect(record.command).toBeUndefined();
  expect(record.image).toBeUndefined();
  expect(record.resources).toBeUndefined();
}

async function assertGuard(
  page: Page,
  guard: ReturnType<typeof installStage4Guard>,
  accessToken: string,
): Promise<void> {
  expect(guard.forbidden).toEqual([]);
  const hooks = await readClientHooks(page);
  for (const url of hooks.wsUrls) {
    expect(url).not.toContain(accessToken);
    expect(url).not.toMatch(/accessToken|Bearer |eyJ/);
    if (url.includes('/api/v1/ws/run-logs')) {
      expect(url).toMatch(/ticket=mock-run-log-ticket-/);
    }
    expect(url.includes('/terminal') || url.includes(':4174')).toBe(false);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as unknown as {
      __e2eFetchHooks: {
        holdActive: boolean;
        holdRootTree: boolean;
        holdContentPut: boolean;
        failNextRootTree: boolean;
        abortNextStart: boolean;
        wsUrls: string[];
        wsFrames: string[];
        closeCodes: number[];
        socketTraces: SocketTrace[];
        liveSockets: WebSocket[];
        activeResolvers: Array<() => void>;
        treeResolvers: Array<() => void>;
        writeResolvers: Array<() => void>;
      };
      __e2eFetchWrapped?: boolean;
    };
    if (host.__e2eFetchHooks === undefined) {
      host.__e2eFetchHooks = {
        holdActive: false,
        holdRootTree: false,
        holdContentPut: false,
        failNextRootTree: false,
        abortNextStart: false,
        wsUrls: [],
        wsFrames: [],
        closeCodes: [],
        socketTraces: [],
        liveSockets: [],
        activeResolvers: [],
        treeResolvers: [],
        writeResolvers: [],
      };
    }
    if (host.__e2eFetchWrapped === true) {
      return;
    }
    host.__e2eFetchWrapped = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const hooks = host.__e2eFetchHooks;
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      let pathname = url;
      let pathParam = '';
      try {
        const parsed = new URL(url, window.location.origin);
        pathname = parsed.pathname;
        pathParam = parsed.searchParams.get('path') ?? '';
      } catch {
        pathname = url;
      }
      if (hooks.holdActive && /\/runs\/active$/.test(pathname)) {
        await new Promise<void>((resolve) => {
          hooks.activeResolvers.push(resolve);
        });
      }
      if (hooks.holdRootTree && pathname.includes('/files/tree') && pathParam === '') {
        await new Promise<void>((resolve) => {
          hooks.treeResolvers.push(resolve);
        });
      }
      if (hooks.holdContentPut && method === 'PUT' && pathname.includes('/files/content')) {
        await new Promise<void>((resolve) => {
          hooks.writeResolvers.push(resolve);
        });
      }
      if (
        hooks.failNextRootTree &&
        method === 'GET' &&
        pathname.includes('/files/tree') &&
        pathParam === ''
      ) {
        hooks.failNextRootTree = false;
        return new Response(
          JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: 'Mock reload tree failure',
            traceId: 'e2e-stage4-reload',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (hooks.abortNextStart && method === 'POST' && /\/projects\/[^/]+\/runs$/.test(pathname)) {
        hooks.abortNextStart = false;
        await originalFetch(input, init);
        throw new TypeError('Failed to fetch');
      }
      return originalFetch(input, init);
    };
  });
});

test('loads active authority before File editing is available', async ({ page }) => {
  const guard = installStage4Guard(page);
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await expect(page).toHaveURL(/\/projects$/);
  await patchClientHooks(page, { holdActive: true });
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await openRunPanel(page);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start run' })).toHaveAttribute(
    'title',
    /AUTHORITY_LOADING/,
  );
  expect(guard.startPosts).toHaveLength(0);
  await patchClientHooks(page, { holdActive: false });
  await expect(page.getByRole('button', { name: 'New file' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
  await assertGuard(page, guard, accessToken);
});

test('blocks Start when dirty, write pending, or revision is missing', async ({ page }) => {
  const guard = installStage4Guard(page);
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await patchClientHooks(page, { holdRootTree: true });
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await openRunPanel(page);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start run' })).toHaveAttribute(
    'title',
    /REVISION_UNAVAILABLE|AUTHORITY_LOADING/,
  );
  expect(guard.startPosts).toHaveLength(0);
  const treeResponse = waitForFileApi(page, 'tree', '');
  await patchClientHooks(page, { holdRootTree: false });
  const treeBody = (await (await treeResponse).json()) as { workspaceRevision?: string };
  await expect(treeItem(page, '.gitignore')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();

  await openFilePanel(page);
  await openFile(page, 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE4DIRTY');
  await openRunPanel(page);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start run' })).toHaveAttribute('title', /DIRTY_FILES/);
  await page.getByRole('button', { name: 'Start run' }).click({ force: true });
  expect(guard.startPosts).toHaveLength(0);

  await openFilePanel(page);
  await setWriteScenario(page, accessToken, 'delayed');
  const saved = page.getByRole('status', { name: 'Saved' });
  await patchClientHooks(page, { holdContentPut: true });
  await saveButton(page).click();
  await openRunPanel(page);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start run' })).toHaveAttribute(
    'title',
    /WRITE_PENDING|DIRTY_FILES/,
  );
  await patchClientHooks(page, { holdContentPut: false });
  await openFilePanel(page);
  await expect(saved).toBeVisible();
  await setWriteScenario(page, accessToken, 'normal');
  expect(guard.startPosts).toHaveLength(0);
  expect(typeof treeBody.workspaceRevision).toBe('string');
  await assertGuard(page, guard, accessToken);
});

test('starts with the exact revision, no command, and locks File', async ({ page }) => {
  const guard = installStage4Guard(page);
  const { accessToken, workspaceRevision } = await openAliceWorkbench(page);
  await openFile(page, 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  const startResponse = page.waitForResponse(
    (response) => isStartRunPost(response.request()) && response.status() === 202,
  );
  await page.getByRole('button', { name: 'Start run' }).click();
  const response = await startResponse;
  const body = JSON.parse(guard.startPosts[0]?.postData() ?? '{}') as Record<string, unknown>;
  assertStartBody(body, workspaceRevision);
  expect(response.status()).toBe(202);
  await expect(page.getByLabel('Run state')).toHaveText(/STARTING|RUNNING/);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await openFilePanel(page);
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New folder' })).toBeDisabled();
  await openRunPanel(page);
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeEnabled();
  await assertGuard(page, guard, accessToken);
  await expect.poll(() => guard.ticketUrls.length).toBeGreaterThan(0);
  expect(guard.ticketUrls.every((url) => !url.includes(accessToken))).toBe(true);
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      return (
        hooks.wsUrls.some((url) => url.includes('/api/v1/ws/run-logs?ticket=')) ||
        guard.ticketUrls.some((url) => url.includes('/log-ticket'))
      );
    })
    .toBe(true);
});

test('reconciles duplicate start and start network ambiguity to the active run', async ({
  page,
}) => {
  const guard = installStage4Guard(page);
  const { accessToken, workspaceRevision } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  const duplicate = await page.evaluate(async ({ token, projectId, revision }) => {
    const response = await fetch(`/api/v1/projects/${projectId}/runs`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expectedWorkspaceRevision: revision }),
    });
    const payload = (await response.json()) as { code?: string };
    return { status: response.status, code: payload.code ?? null };
  }, {
    token: accessToken,
    projectId: ALICE_SEED_PROJECT_ID,
    revision: workspaceRevision,
  });
  expect(duplicate.status).toBe(409);
  expect(duplicate.code).toBe('RUN_ALREADY_ACTIVE');
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();

  await page.getByRole('button', { name: 'Stop run' }).click();
  await page.getByRole('dialog', { name: 'Stop run' }).getByRole('button', { name: 'Stop' }).click();
  await waitUntilWritable(page);

  await patchClientHooks(page, { abortNextStart: true });
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await expect(page.getByLabel('Run state')).toHaveText(/STARTING|RUNNING/);
  await assertGuard(page, guard, accessToken);
});

test('keeps dirty File buffers and log text when switching File and Run', async ({ page }) => {
  const { accessToken } = await openAliceWorkbench(page);
  await openFile(page, 'pom.xml');
  await waitForMonacoText(page, 'artifactId');
  await typeInMonaco(page, 'STAGE4SWITCH');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  await openRunPanel(page);
  await expect(page.getByRole('button', { name: 'Start run' })).toBeDisabled();
  await openFilePanel(page);
  expect(await monacoValue(page, 'pom.xml')).toContain('STAGE4SWITCH');
  await expect(editorTab(page, /pom\.xml/)).toContainText('*');
  await saveButton(page).click();
  await expect(page.getByRole('status', { name: 'Saved' })).toBeVisible();
  await expect(editorTab(page, /pom\.xml/)).not.toContainText('*');
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
  await openFilePanel(page);
  await expect(editorTab(page, /pom\.xml/)).toBeVisible();
  await openRunPanel(page);
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
});

test('replays then lives, and reconnect replay includes chunks persisted while disconnected', async ({
  page,
}) => {
  const guard = installStage4Guard(page);
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  const log = page.getByRole('region', { name: 'Run logs' });
  await expect(log).toContainText(SEED_LOG_MARKER);
  await expect.poll(() => guard.ticketUrls.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      const unavailable = [...hooks.wsFrames, ...hooks.socketTraces.flatMap((trace) => trace.frames)].some(
        (raw) => {
          const parsed = parseLogFrame(raw);
          return parsed?.type === 'stream.error' && parsed.code === 'STREAM_UNAVAILABLE';
        },
      );
      const closed1011 =
        hooks.closeCodes.includes(1011) ||
        hooks.socketTraces.some((trace) => trace.closeCode === 1011);
      return unavailable || closed1011;
    }, { timeout: 20_000 })
    .toBe(true);
  await expect(log).toContainText(PERSISTED_OFFLINE_MARKER, { timeout: 20_000 });
  await expect(log).toContainText(RECONNECT_LIVE_MARKER, { timeout: 20_000 });
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      const replays = replayChunkBodies(hooks.wsFrames);
      if (replays.length < 2) {
        return false;
      }
      const firstReplay = replays[0] ?? [];
      if (firstReplay.some((text) => text.includes(PERSISTED_OFFLINE_MARKER))) {
        return false;
      }
      const laterHasPersisted = replays
        .slice(1)
        .some((body) => body.some((text) => text.includes(PERSISTED_OFFLINE_MARKER)));
      const replayThenLive = hooks.socketTraces.some((trace) => socketHasReplayThenLive(trace));
      const liveAfterReplay = hooks.socketTraces.some((trace) => {
        if (!socketHasReplayThenLive(trace)) {
          return false;
        }
        return trace.frames.some((raw) => {
          const parsed = parseLogFrame(raw);
          return (
            parsed?.type === 'log.append' &&
            (parsed.chunk?.text ?? '').includes(RECONNECT_LIVE_MARKER)
          );
        });
      });
      return laterHasPersisted && replayThenLive && liveAfterReplay;
    }, { timeout: 20_000 })
    .toBe(true);
  expect((await log.innerText()).split(SEED_LOG_MARKER).length - 1).toBe(1);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await assertGuard(page, guard, accessToken);
});

test('gap skipped seq fetches a fresh ticket and replays the missing chunk; duplicate seq is ignored', async ({
  page,
}) => {
  const guard = installStage4Guard(page);
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'gap');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  const log = page.getByRole('region', { name: 'Run logs' });
  await expect(log).toContainText(SEED_LOG_MARKER);
  await expect(log).toContainText(GAP_DUP_MARKER, { timeout: 20_000 });
  await expect(log).toContainText(GAP_VISIBLE_MARKER, { timeout: 20_000 });
  await expect.poll(() => guard.ticketUrls.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect(log).toContainText(GAP_SKIPPED_MARKER, { timeout: 20_000 });
  expect(guard.ticketUrls.length).toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      if (!socketReplayBeforeAppend({ url: '', frames: hooks.wsFrames, closeCode: null })) {
        return false;
      }
      const hasDuplicateAppend = [...appendSeqCounts(hooks.wsFrames).values()].some(
        (count) => count > 1,
      );
      const skippedInReplay = hooks.wsFrames.some((raw) => {
        const frame = parseLogFrame(raw);
        return (
          frame?.type === 'log.replay' &&
          (frame.chunks ?? []).some((chunk) => (chunk.text ?? '').includes(GAP_SKIPPED_MARKER))
        );
      });
      return hasDuplicateAppend && skippedInReplay;
    }, { timeout: 20_000 })
    .toBe(true);
  const hooks = await readClientHooks(page);
  expect([...appendSeqCounts(hooks.wsFrames).values()].some((count) => count > 1)).toBe(true);
  expect(guard.ticketUrls.length).toBeGreaterThanOrEqual(2);
  const logText = await log.innerText();
  expect(logText.split(GAP_DUP_MARKER).length - 1).toBe(1);
  expect(logText.split(GAP_VISIBLE_MARKER).length - 1).toBe(1);
  expect(logText.split(GAP_SKIPPED_MARKER).length - 1).toBe(1);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await assertGuard(page, guard, accessToken);
});

test('ignores log frames from a stale socket generation', async ({ page }) => {
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  const log = page.getByRole('region', { name: 'Run logs' });
  await expect(log).toContainText(SEED_LOG_MARKER);
  await expect(log).toContainText(RECONNECT_LIVE_MARKER, { timeout: 20_000 });
  await expect
    .poll(async () => {
      const hooks = await readClientHooks(page);
      const urls = distinctRunLogUrls(hooks.socketTraces);
      const second = hooks.socketTraces.find((trace) => trace.url === urls[1]);
      const lastSeq = lastAppliedSeqFromFrames(hooks.wsFrames);
      return (
        urls.length >= 2 &&
        second !== undefined &&
        socketReplayBeforeAppend(second) &&
        lastSeq !== null
      );
    }, { timeout: 20_000 })
    .toBe(true);
  const hooks = await readClientHooks(page);
  const urls = distinctRunLogUrls(hooks.socketTraces);
  expect(urls.length).toBeGreaterThanOrEqual(2);
  expect(urls[0]).not.toBe(urls[1]);
  const lastSeq = lastAppliedSeqFromFrames(hooks.wsFrames);
  expect(lastSeq).not.toBeNull();
  const nextSeq = (lastSeq as number) + 1;
  await injectStaleLogAppend(page, {
    marker: STALE_SOCKET_MARKER,
    seq: nextSeq,
    socketIndex: 0,
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  await expect(log).toContainText(SEED_LOG_MARKER);
  await expect(log).toContainText(RECONNECT_LIVE_MARKER);
  await expect(log).not.toContainText(STALE_SOCKET_MARKER);
  const after = await readClientHooks(page);
  const firstFrames = after.socketTraces[0]?.frames ?? [];
  const secondFrames = after.socketTraces[1]?.frames ?? [];
  const staleOnFirst = firstFrames
    .map(parseLogFrame)
    .some(
      (frame) =>
        frame?.type === 'log.append' &&
        frame.chunk?.seq === nextSeq &&
        (frame.chunk.text ?? '').includes(STALE_SOCKET_MARKER),
    );
  expect(staleOnFirst).toBe(true);
  expect(secondFrames.some((raw) => raw.includes(STALE_SOCKET_MARKER))).toBe(false);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
});

test('Stop Cancel leaves the run; confirm is idempotent STOPPING then CANCELLED', async ({
  page,
}) => {
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  const stop = page.getByRole('button', { name: 'Stop run' });
  await stop.click();
  const dialog = page.getByRole('dialog', { name: 'Stop run' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(stop).toBeFocused();
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await stop.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByLabel('Run state')).toHaveText(/STOPPING|CANCELLED|Reloading/);
  await waitUntilWritable(page);
  await expect(page.getByLabel('Run state')).toHaveText(/CANCELLED|Idle/);
});

test('offline log transport does not unlock File', async ({ page }) => {
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await expect(page.getByLabel('Log connection')).toHaveText('Live');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
  });
  await expect(page.getByLabel('Log connection')).toHaveText(/Reconnecting/);
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await expect(page.getByLabel('Run state')).not.toHaveText(/Idle/);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
});

test('success, failure and timeout each reload the workspace before unlocking edit', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { accessToken } = await openAliceWorkbench(page);
  const terminalByScenario = {
    success: 'SUCCEEDED',
    failure: 'FAILED',
    timeout: 'TIMED_OUT',
  } as const;
  for (const scenario of ['success', 'failure', 'timeout'] as const) {
    await openFilePanel(page);
    await expect(page.getByRole('button', { name: 'New file' })).toBeEnabled();
    await setRunScenario(page, accessToken, scenario);
    await openRunPanel(page);
    await expect(page.getByRole('button', { name: 'Start run' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
    await waitUntilWritable(page);
    await expect(
      page.getByRole('list', { name: 'Recent runs' }).getByRole('button').first(),
    ).toHaveAttribute('aria-label', new RegExp(terminalByScenario[scenario]));
    await openFilePanel(page);
    await expect(page.getByRole('button', { name: 'New file' })).toBeEnabled();
  }
});

test('reload-change updates files and Retry recovers a failed workspace reload', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { accessToken } = await openAliceWorkbench(page);
  await openFile(page, 'README.md');
  await waitForMonacoText(page, 'Alice Notebook');
  await expandDirectory(page, 'src', 'src');
  await expandDirectory(page, 'test', 'src/test');
  await expandDirectory(page, 'java', 'src/test/java');
  await expandDirectory(page, 'demo', 'src/test/java/demo');
  await openFile(page, 'AppTest.java');
  await waitForMonacoText(page, 'AppTest');

  await setRunScenario(page, accessToken, 'success');
  await openRunPanel(page);
  await patchClientHooks(page, { failNextRootTree: true });
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByText('Workspace reload failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry workspace reload' }).click();
  await waitUntilWritable(page);

  await setRunScenario(page, accessToken, 'reload-change');
  await page.getByRole('button', { name: 'Start run' }).click();
  await waitUntilWritable(page);
  await openFilePanel(page);
  await expect(editorTab(page, /README\.md/)).toBeVisible();
  await expect(editorTab(page, /AppTest\.java/)).toHaveCount(0);
  await waitForMonacoText(page, RELOAD_MARKER);
  await expandDirectory(page, 'docs', 'docs');
  await expect(treeItem(page, 'run-output.md')).toBeVisible();
  await expect(treeItem(page, 'AppTest.java')).toHaveCount(0);
});

test('refresh restores the browser recovery lock and log cursor, not MySQL', async ({ page }) => {
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  const persisted = await page.evaluate(() => sessionStorage.getItem('ensoai.mock.run-scenario.v1'));
  expect(persisted).toContain('disconnect');
  expect(persisted).toContain(SEED_LOG_MARKER);
  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await openRunPanel(page);
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);

  await page.reload();
  await expect(page.getByLabel('Username')).toBeVisible();
  await signIn(page, ALICE);
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file' })).toBeDisabled();
  await openRunPanel(page);
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
});

test('paginates history and isolates the selected run from the active log', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/login');
  const accessToken = await signIn(page, ALICE);
  await setRunScenario(page, accessToken, 'success');
  const workspaceRevision = await page.evaluate(async ({ token, projectId }) => {
    const response = await fetch(`/api/v1/projects/${projectId}/files/tree?path=`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { workspaceRevision?: string };
    if (typeof body.workspaceRevision !== 'string' || body.workspaceRevision.length === 0) {
      throw new Error('missing workspace revision');
    }
    return body.workspaceRevision;
  }, { token: accessToken, projectId: ALICE_SEED_PROJECT_ID });
  await page.evaluate(async ({ token, projectId, revision }) => {
    for (let index = 0; index < 21; index += 1) {
      const start = await fetch(`/api/v1/projects/${projectId}/runs`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expectedWorkspaceRevision: revision }),
      });
      if (start.status !== 202) {
        throw new Error(`seed start ${start.status}`);
      }
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const active = await fetch(`/api/v1/projects/${projectId}/runs/active`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
        const body = (await active.json()) as { run: unknown };
        if (body.run === null) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }, {
    token: accessToken,
    projectId: ALICE_SEED_PROJECT_ID,
    revision: workspaceRevision,
  });
  const rootTree = waitForFileApi(page, 'tree', '');
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await rootTree;
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await openRunPanel(page);
  const history = page.getByRole('list', { name: 'Recent runs' });
  await expect(history.getByRole('button')).toHaveCount(20);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(history.getByRole('button')).toHaveCount(21);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

  await setRunScenario(page, accessToken, 'disconnect');
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  const historical = history.getByRole('button').nth(1);
  await historical.click();
  await expect(page.getByLabel('Run state')).toHaveText(/SUCCEEDED/);
  await expect(page.getByLabel('Log connection')).toHaveText(/Complete|Live|Idle/);
  await history.getByRole('button').first().click();
  await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
  await historical.click();
  await expect(page.getByLabel('Run state')).toHaveText(/SUCCEEDED/);
  await expect(page.getByLabel('Run state')).not.toHaveText(/RUNNING/);
});

test('logout and current 401 close the stream; stale 401 does not clear Bob', async ({ page }) => {
  test.setTimeout(90_000);
  const sockets: Array<{ url: () => string; isClosed: () => boolean }> = [];
  page.on('websocket', (ws) => {
    sockets.push(ws);
  });
  const { accessToken } = await openAliceWorkbench(page);
  await setRunScenario(page, accessToken, 'disconnect');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => sockets.filter((item) => item.url().includes('run-logs')).every((item) => item.isClosed())).toBe(
    true,
  );

  const bobToken = await signIn(page, BOB);
  await expect(page.getByLabel('Username')).toHaveCount(0);
  const bobCard = projectCard(page, 'Bob Lab');
  if ((await bobCard.count()) === 0) {
    await page.getByRole('link', { name: 'Back to projects' }).click();
  }
  await expect(page).toHaveURL(/\/projects$/);
  await expect(bobCard).toBeVisible();
  await expect(projectCard(page, 'Alice Notebook')).toHaveCount(0);
  await bobCard.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Bob Lab' })).toBeVisible();
  await expect(treeItem(page, 'lab-notes.md')).toBeVisible();
  const staleExpire = await page.evaluate(async (token) => {
    const response = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return response.status;
  }, accessToken);
  expect(staleExpire).toBe(204);
  await triggerSessionRefetch(page);
  await expect(page.getByRole('heading', { name: 'Bob Lab' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${BOB_SEED_PROJECT_ID}$`));

  await page.getByRole('button', { name: 'Log out' }).click();
  const aliceToken = await signIn(page, ALICE);
  await expect(page.getByLabel('Username')).toHaveCount(0);
  const aliceCard = projectCard(page, 'Alice Notebook');
  if ((await aliceCard.count()) === 0) {
    await page.getByRole('link', { name: 'Back to projects' }).click();
  }
  await aliceCard.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  const unauthorized = page.waitForResponse((response) => response.status() === 401);
  const expireStatus = await page.evaluate(async (token) => {
    const response = await fetch('/api/v1/session/expire', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    return response.status;
  }, aliceToken);
  expect(expireStatus).toBe(204);
  await triggerSessionRefetch(page);
  try {
    await page.getByRole('button', { name: 'Refresh' }).click({ timeout: 2_000 });
  } catch {
    // Live log reconnect may already have consumed the 401 and landed on login.
  }
  expect((await unauthorized).status()).toBe(401);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(SESSION_EXPIRED);
  expect(bobToken.length).toBeGreaterThan(0);
});

test('Terminal stays lazy and no terminal or echo-ws endpoint is used before Open', async ({ page }) => {
  const guard = installStage4Guard(page);
  const { accessToken } = await openAliceWorkbench(page);
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('region', { name: 'Job terminal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  await setRunScenario(page, accessToken, 'success');
  await openRunPanel(page);
  await page.getByRole('button', { name: 'Start run' }).click();
  await waitUntilWritable(page);
  expect(guard.forbidden).toEqual([]);
  const hooks = await readClientHooks(page);
  expect(hooks.wsUrls.some((url) => url.includes('/terminal') || url.includes(':4174'))).toBe(false);
  await assertGuard(page, guard, accessToken);
});

test('completes File, Run, Start, history, log, New output and Stop from the keyboard', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { accessToken } = await openAliceWorkbench(page);
  expect(
    await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  ).toBe(true);
  await setRunScenario(page, accessToken, 'disconnect');
  await tabUntilFocused(page, page.getByRole('tab', { name: 'File' }));
  await assertFocusVisible(page.getByRole('tab', { name: 'File' }));
  await tabUntilFocused(page, page.getByRole('tab', { name: 'Run' }));
  await assertFocusVisible(page.getByRole('tab', { name: 'Run' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  await tabUntilFocused(page, page.getByRole('button', { name: 'Start run' }));
  await assertFocusVisible(page.getByRole('button', { name: 'Start run' }));
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Run state')).toHaveText(/STARTING|RUNNING/);
  await expect(page.getByLabel('Run state')).toHaveAttribute('role', 'status');
  const historyButton = page.getByRole('list', { name: 'Recent runs' }).getByRole('button').first();
  await tabUntilFocused(page, historyButton);
  await assertFocusVisible(historyButton);
  const log = page.getByRole('region', { name: 'Run logs' });
  await tabUntilFocused(page, log);
  await expect(log).toBeFocused();
  await expect(log).toContainText(SEED_LOG_MARKER);
  await log.evaluate((element) => {
    const pre = element.querySelector('pre');
    if (pre instanceof HTMLElement) {
      pre.style.minHeight = `${element.clientHeight + 80}px`;
    }
    element.scrollTop = element.scrollHeight;
  });
  const newOutput = page.getByRole('button', { name: 'New output' });
  await expect
    .poll(async () => {
      await log.evaluate((element) => {
        element.scrollTop = 0;
      });
      return newOutput.isVisible();
    }, { timeout: 10_000 })
    .toBe(true);
  await tabUntilFocused(page, newOutput, 20);
  await assertFocusVisible(newOutput);
  await page.keyboard.press('Enter');
  await expect(newOutput).toHaveCount(0);
  await expect(page.getByLabel('Log connection')).toHaveText(/Live|Reconnecting|Replaying|Complete/);
  const stop = page.getByRole('button', { name: 'Stop run' });
  await expect(stop).toBeEnabled();
  await tabUntilFocused(page, stop, 20);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Stop run' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(stop).toBeFocused();
  await expect(stop).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Stop' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Run state')).toHaveText(/STOPPING|CANCELLED|Reloading|Idle/);
});

for (const viewport of viewports) {
  test(`captures active Run and truncated log at ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(!['chrome', 'edge'].includes(testInfo.project.name));
    test.setTimeout(180_000);

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { accessToken } = await openAliceWorkbench(page);
    await setRunScenario(page, accessToken, 'large-log');
    await openRunPanel(page);
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByLabel('Run state')).toHaveText(/RUNNING/);
    await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(SEED_LOG_MARKER, {
      timeout: 20_000,
    });

    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertRunGeometry(page);
    await assertReachable(page.getByRole('toolbar', { name: 'Run controls' }));
    await assertReachable(page.getByRole('complementary', { name: 'Recent runs' }));
    await assertReachable(page.getByRole('region', { name: 'Run logs' }));
    await assertReachable(page.getByRole('button', { name: 'Stop run' }));
    await assertReachable(page.getByRole('tab', { name: 'Terminal' }));
    if (viewport.width === 1280) {
      await assertNoHorizontalOverflow(page);
    }
    await captureViewport(
      page,
      `../docs/evidence/stage-4/${testInfo.project.name}-run-${viewport.name}.png`,
      viewport,
    );

    const truncation = page.getByLabel('Log truncation');
    await expect(truncation).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('region', { name: 'Run logs' })).toContainText(LATEST_MARKER);
    await expect(page.getByRole('region', { name: 'Run logs' })).not.toContainText(HEAD_MARKER);
    await expect(page.getByRole('region', { name: 'Run logs' })).not.toContainText(EVICTED_EARLY_MARKER);
    await prepareVisualCapture(page);
    await assertNoHorizontalOverflow(page);
    await assertRunGeometry(page);
    await assertInsideViewport(truncation);
    await assertReachable(truncation);
    await assertReachable(page.getByRole('region', { name: 'Run logs' }));
    await assertReachable(page.getByRole('toolbar', { name: 'Run controls' }));
    const logPng = await page.getByRole('region', { name: 'Run logs' }).screenshot({
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
    expect(pngHasNonBackgroundText(new Uint8Array(logPng))).toBe(true);
    if (viewport.width === 1280) {
      await assertNoHorizontalOverflow(page);
    }
    await captureViewport(
      page,
      `../docs/evidence/stage-4/${testInfo.project.name}-truncated-log-${viewport.name}.png`,
      viewport,
    );
  });
}
