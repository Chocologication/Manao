import { inflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

const ALICE = { username: 'alice', password: 'demo-pass' };
const BOB = { username: 'bob', password: 'demo-pass' };
const ALICE_PROJECT_ID = 'prj-alice-notebook';

type TerminalScenario =
  | 'normal'
  | 'ticket-expired'
  | 'ticket-unavailable'
  | 'already-active'
  | 'server-pause'
  | 'disconnect'
  | 'shell-exit'
  | 'webgl-fallback'
  | 'audit'
  | 'stress';

type BrowserFrame = {
  direction: 'sent' | 'received';
  kind: 'text' | 'binary';
  text: string | null;
  bytes: number;
  preview: number[];
};

type BrowserSocket = {
  url: string;
  frames: BrowserFrame[];
  closeCode: number | null;
};

type BrowserHooks = {
  sockets: BrowserSocket[];
  events: Array<{ kind: 'fetch' | 'socket-close'; value: string; at: number }>;
  resizeObserved: number;
  forceWebglFailure: boolean;
  forcedBufferedAmount: number | null;
  maxBufferedObserved: number;
};

type TerminalCssSnapshot = {
  stylesheetUrls: string[];
  resourceUrls: string[];
  xtermSelectors: Array<{ url: string; selector: string }>;
};

function isLazyJobTerminalJavaScriptUrl(url: string): boolean {
  return /\/assets\/JobTerminalPanel-[^/]+\.js$/.test(new URL(url).pathname);
}

function projectCard(page: Page, name: string) {
  return page.getByRole('article', { name });
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function paeth(left: number, up: number, upLeft: number): number {
  const value = left + up - upLeft;
  const leftDistance = Math.abs(value - left);
  const upDistance = Math.abs(value - up);
  const upLeftDistance = Math.abs(value - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

function unfilterPngRow(
  filter: number,
  source: Uint8Array,
  target: Uint8Array,
  previous: Uint8Array,
  bytesPerPixel: number,
): void {
  for (let index = 0; index < source.length; index += 1) {
    const sample = source[index] ?? 0;
    const left = index >= bytesPerPixel ? target[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    target[index] = filter === 0
      ? sample
      : filter === 1
        ? (sample + left) & 0xff
        : filter === 2
          ? (sample + up) & 0xff
          : filter === 3
            ? (sample + Math.floor((left + up) / 2)) & 0xff
            : filter === 4
              ? (sample + paeth(left, up, upLeft)) & 0xff
              : (() => { throw new Error(`unsupported png filter ${filter}`); })();
  }
}

function pngHasNonBackgroundPixels(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...bytes.subarray(0, 8)]).toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
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
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idat));
  let sourceOffset = 0;
  let previous = new Uint8Array(stride);
  const colors = new Set<string>();
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset] ?? 0;
    sourceOffset += 1;
    const source = inflated.subarray(sourceOffset, sourceOffset + stride);
    sourceOffset += stride;
    const current = new Uint8Array(stride);
    unfilterPngRow(filter, source, current, previous, bytesPerPixel);
    previous = current;
    for (let column = 0; column < width; column += 4) {
      const pixel = column * bytesPerPixel;
      if (bytesPerPixel === 4 && current[pixel + 3] === 0) continue;
      colors.add(`${current[pixel]},${current[pixel + 1]},${current[pixel + 2]}`);
      if (colors.size >= 3) return true;
    }
  }
  return false;
}

function terminalRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/v1\/projects\/[^/]+\/runs\/[^/]+\/terminal-sessions$/.test(
        new URL(request.url()).pathname,
      )
    ) {
      requests.push(request);
    }
  });
  return requests;
}

async function terminalCssSnapshot(page: Page): Promise<TerminalCssSnapshot> {
  return page.evaluate(() => {
    const stylesheetUrls = [...document.styleSheets]
      .map((sheet) => sheet.href)
      .filter((href): href is string => href !== null)
      .sort();
    const resourceUrls = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .sort();
    const xtermSelectors: TerminalCssSnapshot['xtermSelectors'] = [];
    const visitRules = (rules: CSSRuleList, url: string) => {
      for (const rule of [...rules]) {
        const selector = (rule as CSSStyleRule).selectorText;
        if (typeof selector === 'string' && selector.includes('.xterm')) {
          xtermSelectors.push({ url, selector });
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested !== undefined) visitRules(nested, url);
      }
    };
    for (const sheet of [...document.styleSheets]) {
      try {
        visitRules(sheet.cssRules, sheet.href ?? 'inline');
      } catch {
        // Same-origin production stylesheets are readable; ignore browser-owned sheets.
      }
    }
    return { stylesheetUrls, resourceUrls, xtermSelectors };
  });
}

async function signIn(
  page: Page,
  credentials: { username: string; password: string } = ALICE,
): Promise<string> {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/v1/auth/login' &&
    response.request().method() === 'POST',
  );
  await page.getByLabel('Username').fill(credentials.username);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const body = (await (await responsePromise).json()) as { accessToken?: unknown };
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken as string;
}

async function installBrowserHooks(page: Page): Promise<void> {
  await page.evaluate(() => {
    type HooksHost = Window & {
      __ensoaiStage5E2E?: BrowserHooks;
      __ensoaiStage5E2EWebSocketWrapped?: boolean;
      __ensoaiStage5E2EResizeWrapped?: boolean;
      __ensoaiStage5E2ECanvasWrapped?: boolean;
      __ensoaiStage5E2EFetchWrapped?: boolean;
      __ensoaiStage5TerminalSockets?: WeakSet<WebSocket>;
    };
    const host = window as HooksHost;
    host.__ensoaiStage5E2E ??= {
      sockets: [],
      events: [],
      resizeObserved: 0,
      forceWebglFailure: false,
      forcedBufferedAmount: null,
      maxBufferedObserved: 0,
    };
    if (host.__ensoaiStage5E2EFetchWrapped !== true) {
      host.__ensoaiStage5E2EFetchWrapped = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const url = new URL(raw, window.location.origin);
        host.__ensoaiStage5E2E?.events.push({
          kind: 'fetch',
          value: `${(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()} ${url.pathname}${url.search}`,
          at: performance.now(),
        });
        return originalFetch(input, init);
      };
    }
    if (host.__ensoaiStage5E2EResizeWrapped !== true) {
      host.__ensoaiStage5E2EResizeWrapped = true;
      const CurrentResizeObserver = window.ResizeObserver;
      window.ResizeObserver = new Proxy(CurrentResizeObserver, {
        construct(target, args, newTarget) {
          const listener = args[0] as ResizeObserverCallback;
          const wrapped: ResizeObserverCallback = (entries, observer) => {
            if (host.__ensoaiStage5E2E !== undefined) {
              host.__ensoaiStage5E2E.resizeObserved += 1;
            }
            listener(entries, observer);
          };
          return Reflect.construct(target, [wrapped], newTarget) as ResizeObserver;
        },
      });
    }
    if (host.__ensoaiStage5E2ECanvasWrapped !== true) {
      host.__ensoaiStage5E2ECanvasWrapped = true;
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(contextId, ...args) {
        if (
          host.__ensoaiStage5E2E?.forceWebglFailure === true &&
          ['webgl', 'webgl2', 'experimental-webgl'].includes(contextId)
        ) {
          return null;
        }
        return Reflect.apply(originalGetContext, this, [contextId, ...args]);
      } as typeof originalGetContext;
    }
    if (host.__ensoaiStage5E2EWebSocketWrapped === true) return;
    host.__ensoaiStage5E2EWebSocketWrapped = true;
    const CurrentWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(CurrentWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        const trace: BrowserSocket = {
          url: String(args[0]),
          frames: [],
          closeCode: null,
        };
        host.__ensoaiStage5E2E?.sockets.push(trace);
        const terminalSocket = new URL(trace.url).pathname === '/api/v1/ws/terminals';
        const originalSend = socket.send.bind(socket);
        Object.defineProperty(socket, 'send', {
          configurable: true,
          value(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
            if (typeof data === 'string') {
              trace.frames.push({
                direction: 'sent', kind: 'text', text: data,
                bytes: new TextEncoder().encode(data).byteLength,
                preview: [],
              });
            } else {
              const bytes = data instanceof Blob
                ? data.size
                : ArrayBuffer.isView(data)
                  ? data.byteLength
                  : data.byteLength;
              const preview = data instanceof Blob
                ? []
                : [...new Uint8Array(
                    ArrayBuffer.isView(data) ? data.buffer : data,
                    ArrayBuffer.isView(data) ? data.byteOffset : 0,
                    Math.min(bytes, 32),
                  )];
              trace.frames.push({
                direction: 'sent', kind: 'binary', text: null, bytes, preview,
              });
            }
            originalSend(data);
          },
        });
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            trace.frames.push({
              direction: 'received', kind: 'text', text: event.data,
              bytes: new TextEncoder().encode(event.data).byteLength,
              preview: [],
            });
          } else if (event.data instanceof ArrayBuffer) {
            trace.frames.push({
              direction: 'received', kind: 'binary', text: null,
              bytes: event.data.byteLength,
              preview: [...new Uint8Array(event.data.slice(0, 32))],
            });
          } else if (event.data instanceof Blob) {
            trace.frames.push({
              direction: 'received', kind: 'binary', text: null,
              bytes: event.data.size,
              preview: [],
            });
          }
        });
        socket.addEventListener('close', (event) => {
          trace.closeCode = event.code;
          host.__ensoaiStage5E2E?.events.push({
            kind: 'socket-close',
            value: trace.url,
            at: performance.now(),
          });
        });
        if (!terminalSocket) return socket;
        return new Proxy(socket, {
          get(targetSocket, property) {
            if (property === 'bufferedAmount') {
              const nativeValue = targetSocket.bufferedAmount;
              const value = host.__ensoaiStage5E2E?.forcedBufferedAmount ?? nativeValue;
              if (host.__ensoaiStage5E2E !== undefined) {
                host.__ensoaiStage5E2E.maxBufferedObserved = Math.max(
                  host.__ensoaiStage5E2E.maxBufferedObserved,
                  value,
                );
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
  });
}

async function browserHooks(page: Page): Promise<BrowserHooks> {
  return page.evaluate(() => {
    const hooks = (window as Window & { __ensoaiStage5E2E?: BrowserHooks })
      .__ensoaiStage5E2E;
    if (hooks === undefined) throw new Error('Stage 5 browser hooks are missing');
    return structuredClone(hooks);
  });
}

async function terminalSockets(page: Page): Promise<BrowserSocket[]> {
  return (await browserHooks(page)).sockets.filter((socket) =>
    new URL(socket.url).pathname === '/api/v1/ws/terminals',
  );
}

function parsedControls(
  socket: BrowserSocket,
  direction: BrowserFrame['direction'],
): Array<Record<string, unknown>> {
  return socket.frames.flatMap((frame) => {
    if (frame.direction !== direction || frame.kind !== 'text' || frame.text === null) return [];
    try {
      const parsed = JSON.parse(frame.text) as unknown;
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

async function updateBrowserHooks(
  page: Page,
  patch: Partial<Pick<BrowserHooks, 'forceWebglFailure' | 'forcedBufferedAmount'>>,
): Promise<void> {
  await page.evaluate((next) => {
    const hooks = (window as Window & { __ensoaiStage5E2E?: BrowserHooks })
      .__ensoaiStage5E2E;
    if (hooks === undefined) throw new Error('Stage 5 browser hooks are missing');
    Object.assign(hooks, next);
  }, patch);
}

async function settleAnimationFrames(page: Page, count = 3): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function xtermInput(page: Page) {
  return page.locator('.xterm-helper-textarea');
}

async function tabUntilFocused(page: Page, locator: Locator, maxTabs = 100): Promise<void> {
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(locator).toBeFocused();
}

async function shiftTabUntilFocused(page: Page, locator: Locator, maxTabs = 20): Promise<void> {
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Shift+Tab');
  }
  await expect(locator).toBeFocused();
}

async function assertFocusVisible(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  await expect.poll(() => locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    return outline || (style.boxShadow !== '' && style.boxShadow !== 'none');
  })).toBe(true);
}

async function assertInsideViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (box === null || viewport === null) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function assertTerminalGeometry(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    root: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    body: document.body.scrollWidth > document.body.clientWidth + 1,
  }));
  expect(overflow).toEqual({ root: false, body: false });
  const header = await page.locator('.workbench-shell > header').boundingBox();
  const sidebar = await page.getByRole('complementary', { name: 'Project files' }).boundingBox();
  const panelTabs = await page.getByRole('tablist', { name: 'Workbench panels' }).boundingBox();
  const terminal = await page.getByRole('region', { name: 'Job terminal' }).boundingBox();
  expect(header).not.toBeNull();
  expect(sidebar).not.toBeNull();
  expect(panelTabs).not.toBeNull();
  expect(terminal).not.toBeNull();
  if (header === null || sidebar === null || panelTabs === null || terminal === null) return;
  expect(header.y + header.height).toBeLessThanOrEqual(panelTabs.y + 1);
  expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(terminal.x + 1);
  expect(panelTabs.y + panelTabs.height).toBeLessThanOrEqual(terminal.y + 1);
}

async function prepareVisualCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const style = document.createElement('style');
    style.dataset.stage5Visual = '';
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(style);
  });
}

async function openAliceWorkbench(page: Page): Promise<string> {
  await page.goto('/login');
  const accessToken = await signIn(page);
  await expect(page).toHaveURL(/\/projects$/);
  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ALICE_PROJECT_ID}$`));
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: '.gitignore', exact: true })).toBeVisible();
  await installBrowserHooks(page);
  return accessToken;
}

async function setScenario(
  page: Page,
  accessToken: string,
  resource: 'run' | 'terminal',
  scenario: string,
): Promise<void> {
  const status = await page.evaluate(async ({ token, resourceName, next }) => {
    const response = await fetch(`/api/v1/session/${resourceName}-scenario`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scenario: next }),
    });
    return response.status;
  }, { token: accessToken, resourceName: resource, next: scenario });
  expect(status).toBe(204);
}

async function startLongRunningRun(page: Page, accessToken: string): Promise<void> {
  await setScenario(page, accessToken, 'run', 'disconnect');
  await page.getByRole('tab', { name: 'Run' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByLabel('Run state')).toHaveText('RUNNING');
}

async function openTerminal(page: Page) {
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    /\/terminal-sessions$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole('button', { name: 'Open terminal' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready');
  return response;
}

test('lazy terminal open binds an exact single-use session and paginated audit contract', async ({
  page,
}) => {
  const requests = terminalRequests(page);
  const accessToken = await openAliceWorkbench(page);

  await expect(page.getByRole('region', { name: 'Job terminal' })).toHaveCount(0);
  expect(requests).toHaveLength(0);
  const cssBeforeSelection = await terminalCssSnapshot(page);
  expect(cssBeforeSelection.xtermSelectors).toEqual([]);
  expect(cssBeforeSelection.resourceUrls.filter(isLazyJobTerminalJavaScriptUrl)).toEqual([]);

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('region', { name: 'Job terminal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  expect(requests).toHaveLength(0);
  await expect.poll(async () => (await terminalCssSnapshot(page)).xtermSelectors.length)
    .toBeGreaterThan(0);
  const cssAfterSelection = await terminalCssSnapshot(page);
  const newStylesheetUrls = cssAfterSelection.stylesheetUrls.filter(
    (url) => !cssBeforeSelection.stylesheetUrls.includes(url),
  );
  const newResourceUrls = cssAfterSelection.resourceUrls.filter(
    (url) => !cssBeforeSelection.resourceUrls.includes(url),
  );
  const newCssResourceUrls = newResourceUrls.filter(
    (url) => new URL(url).pathname.endsWith('.css'),
  );
  const newTerminalJavaScriptUrls = newResourceUrls.filter(isLazyJobTerminalJavaScriptUrl);
  const xtermStylesheetUrls = [
    ...new Set(cssAfterSelection.xtermSelectors.map(({ url }) => url)),
  ];
  expect(newStylesheetUrls.length).toBeGreaterThan(0);
  expect(newResourceUrls.length).toBeGreaterThan(0);
  expect(xtermStylesheetUrls.length).toBeGreaterThan(0);
  expect(xtermStylesheetUrls.every((url) => newStylesheetUrls.includes(url))).toBe(true);
  expect(xtermStylesheetUrls.every((url) => newCssResourceUrls.includes(url))).toBe(true);
  expect(newTerminalJavaScriptUrls).toHaveLength(1);
  console.log('stage5 lazy terminal CSS evidence', JSON.stringify({
    before: cssBeforeSelection,
    after: cssAfterSelection,
    newStylesheetUrls,
    newResourceUrls,
    xtermStylesheetUrls,
    newTerminalJavaScriptUrls,
    terminalSessionPostsBeforeOpen: requests.length,
  }));

  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'audit' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const response = await openTerminal(page);
  const reservation = (await response.json()) as {
    sessionId: string;
    ticket: string;
    expiresAt: string;
  };

  expect(requests).toHaveLength(1);
  const createBody = (await requests[0]?.postDataJSON()) as { cols: number; rows: number };
  expect(createBody).toEqual({
    cols: expect.any(Number),
    rows: expect.any(Number),
  });
  expect(createBody.cols).toBeGreaterThanOrEqual(2);
  expect(createBody.rows).toBeGreaterThanOrEqual(1);
  expect(Object.keys(createBody).sort()).toEqual(['cols', 'rows']);
  expect(requests[0]?.headers().authorization).toBe(`Bearer ${accessToken}`);

  const readTerminalSockets = async () =>
    (await browserHooks(page)).sockets.filter((item) =>
      new URL(item.url).pathname === '/api/v1/ws/terminals',
    );
  await expect.poll(async () => (await readTerminalSockets()).length).toBe(1);
  const [socket] = await readTerminalSockets();
  expect(socket).toBeDefined();
  const socketUrl = new URL(socket?.url ?? 'about:blank');
  expect(socketUrl.origin).toBe('ws://127.0.0.1:4173');
  expect(socketUrl.pathname).toBe('/api/v1/ws/terminals');
  expect([...socketUrl.searchParams.keys()]).toEqual(['ticket']);
  expect(socketUrl.searchParams.get('ticket')).toBe(reservation.ticket);
  expect(socket?.url).not.toContain(accessToken);
  await expect.poll(async () =>
    (await readTerminalSockets())[0]?.frames.some((frame) =>
      frame.direction === 'received' &&
      frame.kind === 'text' &&
      frame.text === JSON.stringify({ type: 'terminal.ready', sessionId: reservation.sessionId }),
    ),
  ).toBe(true);

  const sentControls = parsedControls((await terminalSockets(page))[0]!, 'sent');
  expect(sentControls[0]).toEqual({
    type: 'terminal.resize',
    cols: createBody.cols,
    rows: createBody.rows,
  });
  expect(sentControls[1]).toEqual({ type: 'terminal.output.credit', bytes: 256 * 1024 });
  const reusedTicketCloseCode = await page.evaluate((url) =>
    new Promise<number>((resolve) => {
      const duplicate = new WebSocket(url);
      duplicate.addEventListener('close', (event) => resolve(event.code), { once: true });
    }), socket?.url ?? '');
  expect(reusedTicketCloseCode).toBe(4409);

  const auditUrls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/terminal-audits')) {
      auditUrls.push(request.url());
    }
  });
  await page.getByRole('tab', { name: 'Audit' }).click();
  await expect(page.getByRole('table', { name: 'Terminal command audit' })).toBeVisible();
  const loadMore = page.getByRole('button', { name: 'Load more terminal audit' });
  await expect(loadMore).toBeVisible();
  await expect.poll(() => auditUrls.length).toBe(1);
  expect(new URL(auditUrls[0]!).searchParams.get('limit')).toBe('50');
  const rowsBefore = await page.getByRole('table', { name: 'Terminal command audit' })
    .getByRole('row').count();
  expect(rowsBefore).toBe(51);
  await loadMore.click();
  await expect.poll(() => auditUrls.length).toBe(2);
  expect(new URL(auditUrls[1]!).searchParams.get('cursor')).toMatch(/^mock-terminal-audit-/);
  await expect.poll(async () =>
    page.getByRole('table', { name: 'Terminal command audit' }).getByRole('row').count(),
  ).toBeGreaterThan(rowsBefore);
});

test('preserves Unicode, onBinary mouse bytes, resize dedupe and local search across panels', async ({
  page,
}) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);

  const input = xtermInput(page);
  await expect(input).toBeVisible();
  await input.focus();
  const marker = 'stage5-unicode-终端-😀-needle';
  const markerBytes = [...new TextEncoder().encode(marker)];
  await page.keyboard.insertText(marker);
  await expect.poll(async () =>
    (await terminalSockets(page))[0]?.frames.some((frame) =>
      frame.direction === 'sent' &&
      frame.kind === 'binary' &&
      frame.bytes === markerBytes.length &&
      JSON.stringify(frame.preview) === JSON.stringify(markerBytes.slice(0, 32)),
    ),
  ).toBe(true);
  await expect.poll(async () =>
    (await terminalSockets(page))[0]?.frames.some((frame) =>
      frame.direction === 'received' &&
      frame.kind === 'binary' &&
      frame.bytes === markerBytes.length &&
      JSON.stringify(frame.preview) === JSON.stringify(markerBytes.slice(0, 32)),
    ),
  ).toBe(true);

  const enableMouse = [...new TextEncoder().encode('\u001b[?1000h')];
  await page.keyboard.insertText('\u001b[?1000h');
  await expect.poll(async () =>
    (await terminalSockets(page))[0]?.frames.some((frame) =>
      frame.direction === 'received' &&
      frame.kind === 'binary' &&
      JSON.stringify(frame.preview) === JSON.stringify(enableMouse),
    ),
  ).toBe(true);
  const screen = page.locator('.xterm-screen');
  const screenBox = await screen.boundingBox();
  expect(screenBox).not.toBeNull();
  await page.mouse.click(
    (screenBox?.x ?? 0) + (screenBox?.width ?? 0) - 4,
    (screenBox?.y ?? 0) + Math.min(20, (screenBox?.height ?? 40) / 2),
  );
  await expect.poll(async () =>
    (await terminalSockets(page))[0]?.frames.some((frame) =>
      frame.direction === 'sent' &&
      frame.kind === 'binary' &&
      frame.preview[0] === 0x1b &&
      frame.preview[1] === 0x5b &&
      frame.preview[2] === 0x4d &&
      frame.preview.some((byte) => byte > 0x7f),
    ),
  ).toBe(true);

  const socketCount = (await terminalSockets(page)).length;
  const resizeCount = parsedControls((await terminalSockets(page))[0]!, 'sent')
    .filter((frame) => frame.type === 'terminal.resize').length;
  await page.getByRole('tab', { name: 'File' }).click();
  await expect(page.locator('#workbench-terminal-panel')).toHaveAttribute('inert', '');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await settleAnimationFrames(page);
  expect((await terminalSockets(page)).length).toBe(socketCount);
  expect(parsedControls((await terminalSockets(page))[0]!, 'sent')
    .filter((frame) => frame.type === 'terminal.resize')).toHaveLength(resizeCount);

  await page.getByRole('button', { name: 'Search terminal' }).click();
  const search = page.getByRole('searchbox', { name: 'Search terminal output' });
  await expect(search).toBeFocused();
  await search.fill(marker);
  for (const option of ['Match case', 'Match whole word', 'Use regular expression']) {
    const toggle = page.getByRole('button', { name: option });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  }
  await search.fill('stage5-no-such-output');
  await expect(page.getByRole('search', { name: 'Terminal output search' })
    .getByRole('status')).toHaveText('No results');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();

  const framesBeforeClear = (await terminalSockets(page))[0]!.frames.length;
  await page.getByRole('button', { name: 'Clear terminal' }).click();
  await settleAnimationFrames(page);
  expect((await terminalSockets(page))[0]!.frames).toHaveLength(framesBeforeClear);
  await page.getByRole('button', { name: 'Search terminal' }).click();
  await page.getByRole('searchbox', { name: 'Search terminal output' }).fill(marker);
  await expect(page.getByRole('search', { name: 'Terminal output search' })
    .getByRole('status')).toHaveText('No results');
});

test('honors server pause and browser bufferedAmount backpressure before draining input', async ({
  page,
}) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'server-pause' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);

  const state = page.getByRole('status', { name: 'Terminal state' });
  await expect(state).toHaveText('Ready');
  await expect.poll(async () => {
    const socket = (await terminalSockets(page))[0];
    return socket === undefined
      ? []
      : parsedControls(socket, 'received')
          .filter((frame) => frame.type === 'terminal.input.pause' || frame.type === 'terminal.input.resume')
          .map((frame) => frame.type);
  }).toEqual(['terminal.input.pause', 'terminal.input.resume']);

  await updateBrowserHooks(page, { forcedBufferedAmount: 300 * 1024 });
  const input = xtermInput(page);
  await input.focus();
  const burst = 'b'.repeat(96 * 1024);
  const sentBefore = (await terminalSockets(page))[0]!.frames
    .filter((frame) => frame.direction === 'sent' && frame.kind === 'binary').length;
  await page.keyboard.insertText(burst);
  await expect(state).toHaveText('Input paused');
  expect((await terminalSockets(page))[0]!.frames
    .filter((frame) => frame.direction === 'sent' && frame.kind === 'binary')).toHaveLength(sentBefore);
  expect((await browserHooks(page)).maxBufferedObserved).toBe(300 * 1024);

  await updateBrowserHooks(page, { forcedBufferedAmount: 0 });
  await expect(state).toHaveText('Ready');
  await expect.poll(async () =>
    (await terminalSockets(page))[0]!.frames
      .filter((frame) => frame.direction === 'sent' && frame.kind === 'binary')
      .slice(sentBefore)
      .reduce((total, frame) => total + frame.bytes, 0),
  ).toBe(burst.length);
  expect((await terminalSockets(page))[0]!.frames
    .filter((frame) => frame.direction === 'sent' && frame.kind === 'binary')
    .slice(sentBefore)
    .every((frame) => frame.bytes <= 16 * 1024)).toBe(true);
});

test('close is explicit and abnormal disconnect never reconnects without a fresh session', async ({
  page,
}) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const first = (await (await openTerminal(page)).json()) as { sessionId: string; ticket: string };
  const close = page.getByRole('button', { name: 'Close terminal' });

  await close.click();
  const dialog = page.getByRole('dialog', { name: 'Close terminal session' });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(close).toBeFocused();

  await close.click();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(close).toBeFocused();

  await close.click();
  await dialog.getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Closed');
  const firstSocket = (await terminalSockets(page))[0]!;
  await expect.poll(async () => (await terminalSockets(page))[0]?.closeCode).toBe(1000);
  expect(parsedControls(firstSocket, 'sent')).toContainEqual({ type: 'terminal.close' });
  const closedSocketCount = (await terminalSockets(page)).length;
  await settleAnimationFrames(page, 5);
  expect((await terminalSockets(page)).length).toBe(closedSocketCount);

  const second = (await (await openTerminal(page)).json()) as { sessionId: string; ticket: string };
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.ticket).not.toBe(first.ticket);
  await close.click();
  await dialog.getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Closed');

  await setScenario(page, accessToken, 'terminal', 'disconnect' satisfies TerminalScenario);
  const failedResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/terminal-sessions'),
  );
  await page.getByRole('button', { name: 'Open terminal' }).click();
  const thirdResponse = await failedResponse;
  const third = (await thirdResponse.json()) as { sessionId: string; ticket: string };
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready');
  const thirdXterm = page.locator('.xterm');
  await expect(thirdXterm).toHaveCount(1);
  await thirdXterm.evaluate((element, sessionId) => {
    element.setAttribute('data-stage5-terminal-generation', sessionId);
  }, third.sessionId);
  const thirdSocketIndex = (await terminalSockets(page)).length - 1;
  await expect.poll(async () => {
    const socket = (await terminalSockets(page))[thirdSocketIndex];
    return socket !== undefined &&
      parsedControls(socket, 'received').some((frame) =>
        frame.type === 'terminal.ready' && frame.sessionId === third.sessionId,
      ) &&
      parsedControls(socket, 'sent').some((frame) => frame.type === 'terminal.resize') &&
      parsedControls(socket, 'sent').some((frame) => frame.type === 'terminal.output.credit');
  }).toBe(true);
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Terminal error');
  await expect.poll(async () => (await terminalSockets(page))[thirdSocketIndex]?.closeCode)
    .toBe(1011);
  await expect(page.getByLabel('Run state')).toHaveText('RUNNING');
  await expect(page.locator(`[data-stage5-terminal-generation="${third.sessionId}"]`))
    .toHaveCount(0);
  const createPath = new URL(thirdResponse.url()).pathname.split('/');
  const runId = createPath[createPath.indexOf('runs') + 1];
  expect(runId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async ({ token, projectId, activeRunId, sessionId }) => {
    const response = await fetch(
      `/api/v1/projects/${projectId}/runs/${activeRunId}/terminal-audits?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const body = (await response.json()) as { items?: Array<{ state?: string }> };
    return body.items?.[0]?.state ?? null;
  }, {
    token: accessToken,
    projectId: ALICE_PROJECT_ID,
    activeRunId: runId,
    sessionId: third.sessionId,
  })).toBe('INTERRUPTED');
  const failedSocketCount = (await terminalSockets(page)).length;
  const failedFrameCount = (await terminalSockets(page))[thirdSocketIndex]!.frames.length;
  await settleAnimationFrames(page, 5);
  expect((await terminalSockets(page)).length).toBe(failedSocketCount);
  expect((await terminalSockets(page))[thirdSocketIndex]!.frames).toHaveLength(failedFrameCount);

  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  const fourth = (await (await openTerminal(page)).json()) as { sessionId: string; ticket: string };
  expect(fourth.sessionId).not.toBe(third.sessionId);
  expect(fourth.ticket).not.toBe(third.ticket);
  expect((await terminalSockets(page)).length).toBe(failedSocketCount + 1);
  await expect(page.locator('.xterm')).toHaveCount(1);
  await expect(page.locator(`[data-stage5-terminal-generation="${third.sessionId}"]`))
    .toHaveCount(0);
});

test('persisted pagehide closes the old session and allows a fresh explicit Open after restore', async ({
  page,
}) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const first = (await (await openTerminal(page)).json()) as { sessionId: string; ticket: string };

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });

  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Closed');
  const socketCountAfterHide = (await terminalSockets(page)).length;
  await settleAnimationFrames(page, 5);
  expect((await terminalSockets(page)).length).toBe(socketCountAfterHide);

  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await settleAnimationFrames(page, 2);
  expect((await terminalSockets(page)).length).toBe(socketCountAfterHide);

  const second = (await (await openTerminal(page)).json()) as { sessionId: string; ticket: string };
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.ticket).not.toBe(first.ticket);
  expect((await terminalSockets(page)).length).toBe(socketCountAfterHide + 1);
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready');
});

test('Run STOPPING closes PTY before reload and keeps PTY, audit and Run log markers isolated', async ({
  page,
}) => {
  const requests = terminalRequests(page);
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'audit' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);
  const input = xtermInput(page);
  const ptyMarker = 'ensoai-stage5-pty-only-marker';
  await input.focus();
  await page.keyboard.insertText(ptyMarker);

  await page.getByRole('tab', { name: 'Audit' }).click();
  const audit = page.getByRole('table', { name: 'Terminal command audit' });
  await expect(audit).toContainText('ensoai-stage5-audit-marker');
  await expect(audit).not.toContainText(ptyMarker);
  await page.getByRole('tab', { name: 'Session' }).click();
  await page.getByRole('button', { name: 'Search terminal' }).click();
  await page.getByRole('searchbox', { name: 'Search terminal output' })
    .fill('ensoai-stage4-seed-log');
  await expect(page.getByRole('search', { name: 'Terminal output search' })
    .getByRole('status')).toHaveText('No results');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Run' }).click();
  await expect(page.getByRole('region', { name: 'Run logs' }))
    .toContainText('ensoai-stage4-seed-log');
  await expect(page.getByRole('region', { name: 'Run logs' })).not.toContainText(ptyMarker);
  await page.getByRole('button', { name: 'Stop run' }).click();
  const stopDialog = page.getByRole('dialog', { name: 'Stop run' });
  await stopDialog.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByLabel('Run state')).toHaveText(/STOPPING|CANCELLED|Reloading/);
  await expect.poll(async () => (await terminalSockets(page))[0]?.closeCode).toBe(1000);
  await expect(page.getByRole('button', { name: 'New file' })).toBeEnabled({ timeout: 30_000 });

  const events = (await browserHooks(page)).events;
  const closeAt = events.find((event) =>
    event.kind === 'socket-close' && new URL(event.value).pathname === '/api/v1/ws/terminals',
  )?.at;
  const reloadAt = events.find((event) =>
    event.kind === 'fetch' && event.value.includes('/files/tree?path=') && event.at >= (closeAt ?? 0),
  )?.at;
  expect(closeAt).toEqual(expect.any(Number));
  expect(reloadAt).toEqual(expect.any(Number));
  expect(closeAt!).toBeLessThanOrEqual(reloadAt!);

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('No active run');
  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  await expect(xtermInput(page)).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page.getByRole('tab', { name: 'Run' }).click();
  await page.getByRole('list', { name: 'Recent runs' }).getByRole('button').first().click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await expect(page.getByRole('button', { name: 'Open terminal' })).toBeDisabled();
  expect(requests).toHaveLength(1);
});

test('RECOVERING and shell exit disable terminal input without hidden reconnect', async ({ page }) => {
  const requests = terminalRequests(page);
  const accessToken = await openAliceWorkbench(page);
  await setScenario(page, accessToken, 'run', 'recovery');
  await page.getByRole('tab', { name: 'Run' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect.poll(async () =>
    (await browserHooks(page)).sockets.some((socket) => socket.frames.some((frame) =>
      frame.direction === 'received' &&
      frame.kind === 'text' &&
      frame.text?.includes('RECOVERING') === true,
    )),
  ).toBe(true);
  expect(requests).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'New file' })).toBeEnabled({ timeout: 30_000 });

  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'shell-exit' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/terminal-sessions'),
  );
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await responsePromise;
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Exited');
  await expect(xtermInput(page)).toHaveCount(0);
  const socketCount = (await terminalSockets(page)).length;
  await settleAnimationFrames(page, 5);
  expect((await terminalSockets(page)).length).toBe(socketCount);
});

test('project navigation and logout close terminal authority', async ({ page }) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);
  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect.poll(async () => (await terminalSockets(page))[0]?.closeCode).toBe(1000);

  await projectCard(page, 'Alice Notebook').getByRole('link', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(async () => (await terminalSockets(page))[1]?.closeCode).toBe(1000);
});

test('current terminal 401 expires the active login', async ({ page }) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let rejected = false;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (!rejected && new URL(raw, window.location.origin).pathname.endsWith('/terminal-sessions')) {
        rejected = true;
        return Promise.resolve(new Response(JSON.stringify({
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          traceId: 'stage5-current-401',
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
  });
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('main').getByRole('alert'))
    .toHaveText('Your session has expired. Please sign in again.');
});

test('ticket unavailable at handshake preserves the current login without reconnecting', async ({
  page,
}) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'ticket-unavailable' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/terminal-sessions'),
  );

  await page.getByRole('button', { name: 'Open terminal' }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Terminal error');
  await expect.poll(async () => (await terminalSockets(page))[0]?.closeCode).toBe(4410);
  await expect(page.getByRole('heading', { name: 'Alice Notebook' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page.getByText('Your session has expired. Please sign in again.')).toHaveCount(0);
  const socketCount = (await terminalSockets(page)).length;
  await settleAnimationFrames(page, 5);
  expect((await terminalSockets(page)).length).toBe(socketCount);
});

test.fixme('a stale Alice terminal 401 cannot clear a newer Bob login', async ({ page }) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.evaluate(() => {
    type Host = Window & { __releaseStage5Terminal401?: () => void; __interceptedStage5Terminal401?: boolean };
    const host = window as Host;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(raw, window.location.origin).pathname.endsWith('/terminal-sessions')) {
        return originalFetch(input, init);
      }
      host.__interceptedStage5Terminal401 = true;
      return new Promise<Response>((resolve) => {
        host.__releaseStage5Terminal401 = () => resolve(new Response(JSON.stringify({
          code: 'UNAUTHENTICATED',
          message: 'Authentication required',
          traceId: 'stage5-stale-alice-401',
        }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      });
    };
  });
  await page.getByRole('button', { name: 'Open terminal' }).click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __interceptedStage5Terminal401?: boolean }).__interceptedStage5Terminal401,
  )).toBe(true);
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Creating session');
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, BOB);
  await page.evaluate(() => {
    (window as Window & { __releaseStage5Terminal401?: () => void }).__releaseStage5Terminal401?.();
  });
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Bob Lab')).toBeVisible();
  await settleAnimationFrames(page, 5);
  await expect(page).toHaveURL(/\/projects$/);
  await expect(projectCard(page, 'Bob Lab')).toBeVisible();
  await expect(page.getByText('Your session has expired. Please sign in again.')).toHaveCount(0);
});

test('WebGL creation failure and context loss retain fallback search and resize', async ({ page }) => {
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'webgl-fallback' satisfies TerminalScenario);
  await updateBrowserHooks(page, { forceWebglFailure: true });
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);
  const renderer = page.getByRole('status', { name: 'Terminal renderer' });
  await expect(renderer).toHaveText('DOM fallback');
  const resizeBefore = parsedControls((await terminalSockets(page))[0]!, 'sent')
    .filter((frame) => frame.type === 'terminal.resize').length;
  await page.setViewportSize({ width: 1360, height: 780 });
  await expect.poll(async () =>
    parsedControls((await terminalSockets(page))[0]!, 'sent')
      .filter((frame) => frame.type === 'terminal.resize').length,
  ).toBeGreaterThan(resizeBefore);
  expect((await browserHooks(page)).resizeObserved).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Close terminal' }).click();
  await page.getByRole('dialog', { name: 'Close terminal session' })
    .getByRole('button', { name: 'Close session' }).click();
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Closed');
  await setScenario(page, accessToken, 'terminal', 'normal' satisfies TerminalScenario);
  await updateBrowserHooks(page, { forceWebglFailure: false });
  await openTerminal(page);
  await expect(renderer).toHaveText('WebGL');
  const canvas = page.locator('.xterm-screen canvas').last();
  await expect(canvas).toBeVisible();
  await canvas.evaluate((element) => {
    element.dispatchEvent(new Event('webglcontextlost', { bubbles: false, cancelable: true }));
  });
  await expect(renderer).toHaveText('DOM fallback');

  const marker = 'stage5-fallback-still-live';
  await xtermInput(page).focus();
  await page.keyboard.insertText(marker);
  await page.getByRole('button', { name: 'Search terminal' }).click();
  const search = page.getByRole('searchbox', { name: 'Search terminal output' });
  await search.fill(marker);
  await expect(page.getByRole('search', { name: 'Terminal output search' })
    .getByRole('status')).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(xtermInput(page)).toBeFocused();
});

test.fixme('keyboard-only terminal workflow and branded visual evidence stay accessible', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const accessToken = await openAliceWorkbench(page);
  await setScenario(page, accessToken, 'run', 'disconnect');
  await setScenario(page, accessToken, 'terminal', 'audit' satisfies TerminalScenario);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  const fileTab = page.getByRole('tab', { name: 'File' });
  const runTab = page.getByRole('tab', { name: 'Run' });
  const terminalTab = page.getByRole('tab', { name: 'Terminal' });
  await tabUntilFocused(page, fileTab);
  await assertFocusVisible(fileTab);
  await tabUntilFocused(page, runTab);
  await assertFocusVisible(runTab);
  await page.keyboard.press('Enter');
  const start = page.getByRole('button', { name: 'Start run' });
  await tabUntilFocused(page, start);
  await assertFocusVisible(start);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Run state')).toHaveText('RUNNING');

  await tabUntilFocused(page, terminalTab);
  await assertFocusVisible(terminalTab);
  await page.keyboard.press('Enter');
  const open = page.getByRole('button', { name: 'Open terminal' });
  await tabUntilFocused(page, open);
  await assertFocusVisible(open);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Ready');
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveAttribute('aria-live', 'polite');
  const input = xtermInput(page);
  await expect(input).toBeFocused();
  await page.keyboard.insertText('ensoai-stage5-visual-marker');
  const searchButton = page.getByRole('button', { name: 'Search terminal' });
  await shiftTabUntilFocused(page, searchButton);
  await assertFocusVisible(searchButton);
  await page.keyboard.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search terminal output' });
  await expect(search).toBeFocused();
  await search.fill('ensoai-stage5-visual-marker');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  const auditTab = page.getByRole('tab', { name: 'Audit' });
  await shiftTabUntilFocused(page, auditTab);
  await assertFocusVisible(auditTab);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Terminal command audit' })).toBeVisible();
  await expect(page.locator('#job-terminal-session-view')).toHaveAttribute('inert', '');
  const sessionTab = page.getByRole('tab', { name: 'Session' });
  await shiftTabUntilFocused(page, sessionTab);
  await page.keyboard.press('Enter');
  const close = page.getByRole('button', { name: 'Close terminal' });
  await shiftTabUntilFocused(page, close);
  await assertFocusVisible(close);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Close terminal session' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await dialog.getByRole('button', { name: 'Close session' }).press('Enter');
  await expect(page.getByRole('status', { name: 'Terminal state' })).toHaveText('Closed');

  if (testInfo.project.name !== 'chrome' && testInfo.project.name !== 'edge') return;
  await openTerminal(page);
  await xtermInput(page).focus();
  await page.keyboard.insertText('ensoai-stage5-screenshot-marker');
  await prepareVisualCapture(page);
  for (const viewport of [
    { name: '1280x720', width: 1280, height: 720 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1920x1080', width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleAnimationFrames(page, 4);
    await assertTerminalGeometry(page);
    for (const locator of [
      page.getByRole('toolbar', { name: 'Terminal controls' }),
      page.getByRole('status', { name: 'Terminal state' }),
      page.getByRole('status', { name: 'Terminal renderer' }),
      page.getByTestId('job-terminal-viewport'),
    ]) await assertInsideViewport(locator);
    const xtermBytes = await page.getByTestId('job-terminal-viewport').screenshot({
      animations: 'disabled', caret: 'hide', scale: 'css',
    });
    expect(pngHasNonBackgroundPixels(xtermBytes)).toBe(true);
    const terminalBytes = await page.screenshot({
      path: `../docs/evidence/stage-5/${testInfo.project.name}-terminal-${viewport.name}.png`,
      animations: 'disabled', caret: 'hide', scale: 'css', fullPage: false,
    });
    expect(pngSize(terminalBytes)).toEqual({ width: viewport.width, height: viewport.height });
    expect(pngHasNonBackgroundPixels(terminalBytes)).toBe(true);

    await auditTab.click();
    const auditTable = page.getByRole('table', { name: 'Terminal command audit' });
    await assertInsideViewport(auditTable.locator('xpath=..'));
    await assertInsideViewport(auditTable.getByRole('columnheader', { name: 'Command' }));
    const auditBytes = await page.screenshot({
      path: `../docs/evidence/stage-5/${testInfo.project.name}-audit-${viewport.name}.png`,
      animations: 'disabled', caret: 'hide', scale: 'css', fullPage: false,
    });
    expect(pngSize(auditBytes)).toEqual({ width: viewport.width, height: viewport.height });
    expect(pngHasNonBackgroundPixels(auditBytes)).toBe(true);
    await sessionTab.click();
  }
});

test('captures branded Terminal and Audit evidence with viewport and pixel assertions', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chrome' && testInfo.project.name !== 'edge',
    'Branded channel screenshot evidence only',
  );
  test.setTimeout(120_000);
  const accessToken = await openAliceWorkbench(page);
  await startLongRunningRun(page, accessToken);
  await setScenario(page, accessToken, 'terminal', 'audit' satisfies TerminalScenario);
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await openTerminal(page);
  await xtermInput(page).focus();
  await page.keyboard.insertText('ensoai-stage5-screenshot-marker');
  await prepareVisualCapture(page);
  const auditTab = page.getByRole('tab', { name: 'Audit' });
  const sessionTab = page.getByRole('tab', { name: 'Session' });
  const searchOverlay = page.getByRole('search', { name: 'Terminal output search' });
  for (const viewport of [
    { name: '1280x720', width: 1280, height: 720 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1920x1080', width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await settleAnimationFrames(page, 4);
    await page.getByRole('button', { name: 'Search terminal' }).click();
    await page.getByRole('searchbox', { name: 'Search terminal output' }).fill('stage5-visual-query');
    await assertTerminalGeometry(page);
    for (const locator of [
      page.getByRole('toolbar', { name: 'Terminal controls' }),
      page.getByRole('status', { name: 'Terminal state' }),
      page.getByRole('status', { name: 'Terminal renderer' }),
      page.getByTestId('job-terminal-viewport'),
      searchOverlay,
    ]) await assertInsideViewport(locator);
    const searchBox = await searchOverlay.boundingBox();
    const terminalBox = await page.getByTestId('job-terminal-viewport').boundingBox();
    const toolbarBox = await page.getByRole('toolbar', { name: 'Terminal controls' }).boundingBox();
    const stateBox = await page.getByRole('status', { name: 'Terminal state' }).boundingBox();
    const rendererBox = await page.getByRole('status', { name: 'Terminal renderer' }).boundingBox();
    expect(searchBox).not.toBeNull();
    expect(terminalBox).not.toBeNull();
    expect(toolbarBox).not.toBeNull();
    expect(stateBox).not.toBeNull();
    expect(rendererBox).not.toBeNull();
    if (
      searchBox !== null &&
      terminalBox !== null &&
      toolbarBox !== null &&
      stateBox !== null &&
      rendererBox !== null
    ) {
      expect(searchBox.x).toBeGreaterThanOrEqual(terminalBox.x);
      expect(searchBox.y).toBeGreaterThanOrEqual(terminalBox.y);
      expect(searchBox.x).toBeGreaterThan(terminalBox.x + terminalBox.width / 2);
      expect(searchBox.width).toBeLessThan(terminalBox.width / 2);
      expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(terminalBox.x + terminalBox.width);
      expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(terminalBox.y + terminalBox.height);
      for (const topBox of [toolbarBox, stateBox, rendererBox]) {
        expect(topBox.y + topBox.height).toBeLessThanOrEqual(searchBox.y);
      }
    }
    const xtermBytes = await page.getByTestId('job-terminal-viewport').screenshot({
      animations: 'disabled', caret: 'hide', scale: 'css',
    });
    expect(pngHasNonBackgroundPixels(xtermBytes)).toBe(true);
    const terminalBytes = await page.screenshot({
      path: `../docs/evidence/stage-5/${testInfo.project.name}-terminal-${viewport.name}.png`,
      animations: 'disabled', caret: 'hide', scale: 'css', fullPage: false,
    });
    expect(pngSize(terminalBytes)).toEqual({ width: viewport.width, height: viewport.height });
    expect(pngHasNonBackgroundPixels(terminalBytes)).toBe(true);

    await auditTab.click();
    const auditTable = page.getByRole('table', { name: 'Terminal command audit' });
    await assertInsideViewport(auditTable.locator('xpath=..'));
    await assertInsideViewport(auditTable.getByRole('columnheader', { name: 'Command' }));
    const auditBytes = await page.screenshot({
      path: `../docs/evidence/stage-5/${testInfo.project.name}-audit-${viewport.name}.png`,
      animations: 'disabled', caret: 'hide', scale: 'css', fullPage: false,
    });
    expect(pngSize(auditBytes)).toEqual({ width: viewport.width, height: viewport.height });
    expect(pngHasNonBackgroundPixels(auditBytes)).toBe(true);
    await sessionTab.click();
  }
});
