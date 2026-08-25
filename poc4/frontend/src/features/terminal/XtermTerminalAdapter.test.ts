import { describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
const browserTerminalConstructorOptions = vi.hoisted(() => [] as unknown[]);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: { disableStdin?: boolean };

    constructor(options: { disableStdin?: boolean }) {
      browserTerminalConstructorOptions.push(options);
      this.options = { ...options };
    }

    open(): void {}
    focus(): void {}
    write(_data: string | Uint8Array, callback?: () => void): void { callback?.(); }
    onData(listener: (data: string) => void) {
      void listener;
      return { dispose() {} };
    }
    onBinary(listener: (data: string) => void) {
      void listener;
      return { dispose() {} };
    }
    loadAddon(): void {}
    clear(): void {}
    dispose(): void {}
  },
}));

import {
  XtermTerminalAdapter,
  type XtermAddonPort,
  type XtermAnimationFrameScheduler,
  type XtermDisposable,
  type XtermFitAddonPort,
  type XtermResizeObserverPort,
  type XtermSearchAddonPort,
  type XtermTerminalPort,
  type XtermWebglAddonPort,
} from './XtermTerminalAdapter';

class FakeDisposable implements XtermDisposable {
  private readonly name: string;
  private readonly disposeLog: string[];
  private readonly shouldThrow: boolean;

  constructor(
    name: string,
    disposeLog: string[],
    shouldThrow = false,
  ) {
    this.name = name;
    this.disposeLog = disposeLog;
    this.shouldThrow = shouldThrow;
  }

  dispose(): void {
    this.disposeLog.push(this.name);
    if (this.shouldThrow) throw new Error(`${this.name} dispose failed`);
  }
}

class FakeTerminal implements XtermTerminalPort {
  cols = 80;
  rows = 24;
  options = { disableStdin: true };
  readonly loadedAddons: XtermAddonPort[] = [];
  readonly writes: Array<{ data: string | Uint8Array; callback?: () => void }> = [];
  readonly open = vi.fn<(element: HTMLElement) => void>();
  readonly focus = vi.fn<() => void>();
  readonly clear = vi.fn<() => void>();
  failLoadFor: XtermAddonPort | null = null;
  private dataListener: ((data: string) => void) | null = null;
  private binaryListener: ((data: string) => void) | null = null;
  private readonly disposeLog: string[];
  private readonly throwingDisposer?: 'data-listener' | 'binary-listener' | 'terminal';

  constructor(
    disposeLog: string[],
    throwingDisposer?: 'data-listener' | 'binary-listener' | 'terminal',
  ) {
    this.disposeLog = disposeLog;
    this.throwingDisposer = throwingDisposer;
  }

  loadAddon(addon: XtermAddonPort): void {
    if (addon === this.failLoadFor) throw new Error('addon load failed');
    this.loadedAddons.push(addon);
  }

  onData(listener: (data: string) => void): XtermDisposable {
    this.dataListener = listener;
    return new FakeDisposable(
      'data-listener',
      this.disposeLog,
      this.throwingDisposer === 'data-listener',
    );
  }

  onBinary(listener: (data: string) => void): XtermDisposable {
    this.binaryListener = listener;
    return new FakeDisposable(
      'binary-listener',
      this.disposeLog,
      this.throwingDisposer === 'binary-listener',
    );
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes.push({ data, callback });
  }

  dispose(): void {
    this.disposeLog.push('terminal');
    if (this.throwingDisposer === 'terminal') throw new Error('terminal dispose failed');
  }

  emitData(data: string): void {
    this.dataListener?.(data);
  }

  emitBinary(data: string): void {
    this.binaryListener?.(data);
  }
}

class FakeFitAddon implements XtermFitAddonPort {
  readonly fit = vi.fn<() => void>();
  readonly proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
  private readonly disposeLog: string[];

  constructor(disposeLog: string[]) {
    this.disposeLog = disposeLog;
  }

  dispose(): void {
    this.disposeLog.push('fit');
  }
}

class FakeSearchAddon implements XtermSearchAddonPort {
  readonly findNext = vi.fn(() => true);
  readonly findPrevious = vi.fn(() => true);
  readonly clearDecorations = vi.fn<() => void>();
  private readonly disposeLog: string[];

  constructor(disposeLog: string[]) {
    this.disposeLog = disposeLog;
  }

  dispose(): void {
    this.disposeLog.push('search');
  }
}

class FakeWebglAddon implements XtermWebglAddonPort {
  private contextLossListener: (() => void) | null = null;
  private readonly disposeLog: string[];

  constructor(disposeLog: string[]) {
    this.disposeLog = disposeLog;
  }

  onContextLoss(listener: () => void): XtermDisposable {
    this.contextLossListener = listener;
    return new FakeDisposable('webgl-context-listener', this.disposeLog);
  }

  dispose(): void {
    this.disposeLog.push('webgl');
  }

  loseContext(): void {
    this.contextLossListener?.();
  }
}

class FakeResizeObserver implements XtermResizeObserverPort {
  readonly observe = vi.fn<(element: HTMLElement) => void>();
  private listener: (() => void) | null = null;
  private readonly disposeLog: string[];

  constructor(disposeLog: string[]) {
    this.disposeLog = disposeLog;
  }

  attach(listener: () => void): void {
    this.listener = listener;
  }

  emit(): void {
    this.listener?.();
  }

  disconnect(): void {
    this.disposeLog.push('resize-observer');
  }
}

class FakeAnimationFrameScheduler implements XtermAnimationFrameScheduler {
  private nextId = 1;
  private readonly pending = new Map<number, () => void>();
  readonly requestedCallbacks = new Map<number, () => void>();
  readonly cancelled: number[] = [];

  requestAnimationFrame(callback: () => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, callback);
    this.requestedCallbacks.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id: unknown): void {
    const numericId = Number(id);
    this.cancelled.push(numericId);
    this.pending.delete(numericId);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  flush(): void {
    const entry = this.pending.entries().next().value as [number, () => void] | undefined;
    if (!entry) return;
    this.pending.delete(entry[0]);
    entry[1]();
  }
}

type HarnessOptions = {
  throwingDisposer?: 'data-listener' | 'binary-listener' | 'terminal';
  webglAddonFactory?: () => XtermWebglAddonPort;
};

function createHarness(input?: HarnessOptions | HarnessOptions['throwingDisposer']) {
  const options = typeof input === 'string' ? { throwingDisposer: input } : (input ?? {});
  const disposeLog: string[] = [];
  const terminal = new FakeTerminal(disposeLog, options.throwingDisposer);
  const fitAddon = new FakeFitAddon(disposeLog);
  const searchAddon = new FakeSearchAddon(disposeLog);
  const webglAddon = new FakeWebglAddon(disposeLog);
  const resizeObserver = new FakeResizeObserver(disposeLog);
  const scheduler = new FakeAnimationFrameScheduler();
  const onData = vi.fn<(data: string) => void>();
  const onBinary = vi.fn<(data: string) => void>();
  const onResize = vi.fn<(cols: number, rows: number) => void>();
  const onRendererChange = vi.fn<(renderer: 'webgl' | 'dom') => void>();
  const adapter = new XtermTerminalAdapter({
    onData,
    onBinary,
    onResize,
    onRendererChange,
    scheduler,
    terminalFactory: () => terminal,
    fitAddonFactory: () => fitAddon,
    searchAddonFactory: () => searchAddon,
    webglAddonFactory: options.webglAddonFactory ?? (() => webglAddon),
    resizeObserverFactory: (listener) => {
      resizeObserver.attach(listener);
      return resizeObserver;
    },
  });
  return {
    adapter,
    disposeLog,
    fitAddon,
    onBinary,
    onData,
    onResize,
    onRendererChange,
    resizeObserver,
    scheduler,
    searchAddon,
    terminal,
    webglAddon,
  };
}

function createSizedElement(width: number, height: number): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
  return element;
}

function setElementSize(element: HTMLElement, width: number, height: number): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

describe('XtermTerminalAdapter browser options', () => {
  it.each([false, true])(
    'constructs the browser Terminal directly with reduced motion %s',
    (reducedMotion) => {
      vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
        matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
      })));
      const disposeLog: string[] = [];
      const adapter = new XtermTerminalAdapter({
        fitAddonFactory: () => new FakeFitAddon(disposeLog),
        searchAddonFactory: () => new FakeSearchAddon(disposeLog),
      });

      expect(browserTerminalConstructorOptions.at(-1)).toMatchObject({
        convertEol: false,
        cursorBlink: !reducedMotion,
        cursorStyle: 'bar',
        disableStdin: true,
        fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
        fontSize: 14,
        scrollback: 5_000,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
        },
      });

      adapter.dispose();
      vi.unstubAllGlobals();
    },
  );
});

describe('XtermTerminalAdapter lifecycle', () => {
  it('creates one resource set, opens once, and focuses only after ready', () => {
    const { adapter, fitAddon, searchAddon, terminal, resizeObserver, webglAddon } =
      createHarness();
    const element = document.createElement('div');

    expect(terminal.loadedAddons).toEqual([fitAddon, searchAddon]);
    expect(terminal.focus).not.toHaveBeenCalled();
    adapter.open(element);
    expect(terminal.open).toHaveBeenCalledOnce();
    expect(terminal.open).toHaveBeenCalledWith(element);
    expect(resizeObserver.observe).toHaveBeenCalledWith(element);
    expect(terminal.loadedAddons).toEqual([fitAddon, searchAddon, webglAddon]);
    expect(terminal.focus).not.toHaveBeenCalled();

    adapter.setReady(true);
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(() => adapter.open(element)).toThrow(/already open/i);
    expect(terminal.open).toHaveBeenCalledOnce();
  });

  it('gates input events and disables stdin again when readiness is lost', () => {
    const { adapter, onBinary, onData, terminal } = createHarness();
    adapter.open(document.createElement('div'));
    adapter.setInputEnabled(true);

    terminal.emitData('before-ready');
    terminal.emitBinary('\u0001');
    expect(terminal.options.disableStdin).toBe(true);
    expect(onData).not.toHaveBeenCalled();
    expect(onBinary).not.toHaveBeenCalled();

    adapter.setReady(true);
    expect(terminal.options.disableStdin).toBe(false);
    terminal.emitData('pwd\r');
    terminal.emitBinary('\u0002');
    expect(onData).toHaveBeenCalledWith('pwd\r');
    expect(onBinary).toHaveBeenCalledWith('\u0002');

    adapter.setReady(false);
    terminal.emitData('stale');
    expect(terminal.options.disableStdin).toBe(true);
    expect(onData).toHaveBeenCalledOnce();
  });

  it('runs write receipts only after parsing and preserves receipt order', () => {
    const { adapter, terminal } = createHarness();
    const receipts: string[] = [];
    const first = new Uint8Array([0, 255, 65]);
    const second = new Uint8Array([66]);
    adapter.open(document.createElement('div'));
    adapter.setReady(true);

    expect(adapter.write(first, () => receipts.push('first'))).toBe(true);
    expect(adapter.write(second, () => receipts.push('second'))).toBe(true);
    expect(terminal.writes.map(({ data }) => data)).toEqual([first, second]);
    expect(receipts).toEqual([]);

    terminal.writes[1]?.callback?.();
    expect(receipts).toEqual([]);
    terminal.writes[0]?.callback?.();
    expect(receipts).toEqual(['first', 'second']);
  });

  it('disposes in reverse order once and continues after a disposer throws', () => {
    const { adapter, disposeLog, terminal } = createHarness('binary-listener');
    adapter.open(document.createElement('div'));
    adapter.setReady(true);
    adapter.setInputEnabled(true);

    expect(() => adapter.dispose()).not.toThrow();
    expect(disposeLog).toEqual([
      'webgl-context-listener',
      'webgl',
      'resize-observer',
      'binary-listener',
      'data-listener',
      'search',
      'fit',
      'terminal',
    ]);
    expect(terminal.options.disableStdin).toBe(true);

    adapter.dispose();
    expect(disposeLog).toHaveLength(8);
  });

  it('creates every session resource fresh and isolates the new session from all stale callbacks', () => {
    const old = createHarness();
    const oldReceipt = vi.fn();
    old.adapter.open(createSizedElement(800, 480));
    old.adapter.setInputEnabled(true);
    old.adapter.setReady(true);
    old.adapter.write(new Uint8Array([65]), oldReceipt);
    const oldFrameHandle = old.scheduler.requestedCallbacks.keys().next().value as number;
    const oldFrame = old.scheduler.requestedCallbacks.get(oldFrameHandle);
    old.onRendererChange.mockClear();
    old.adapter.dispose();
    const oldRendererAfterDispose = old.adapter.renderer;
    const oldDisposeCount = old.disposeLog.length;

    const next = createHarness();
    const nextReceipt = vi.fn();
    next.adapter.open(createSizedElement(800, 480));
    next.adapter.setInputEnabled(true);
    next.adapter.setReady(true);
    next.adapter.write(new Uint8Array([66]), nextReceipt);
    const nextFrameHandle = next.scheduler.requestedCallbacks.keys().next().value as number;
    const nextFrame = next.scheduler.requestedCallbacks.get(nextFrameHandle);
    next.onRendererChange.mockClear();

    expect(next.terminal).not.toBe(old.terminal);
    expect(next.fitAddon).not.toBe(old.fitAddon);
    expect(next.searchAddon).not.toBe(old.searchAddon);
    expect(next.webglAddon).not.toBe(old.webglAddon);
    expect(next.resizeObserver).not.toBe(old.resizeObserver);
    expect(next.scheduler).not.toBe(old.scheduler);
    expect(nextFrame).not.toBe(oldFrame);

    oldFrame?.();
    old.resizeObserver.emit();
    old.terminal.writes[0]?.callback?.();
    old.webglAddon.loseContext();
    old.terminal.emitData('old');
    old.terminal.emitBinary('\u0001');

    expect(oldReceipt).not.toHaveBeenCalled();
    expect(old.onData).not.toHaveBeenCalled();
    expect(old.onBinary).not.toHaveBeenCalled();
    expect(old.onResize).not.toHaveBeenCalled();
    expect(old.onRendererChange).not.toHaveBeenCalled();
    expect(old.adapter.renderer).toBe(oldRendererAfterDispose);
    expect(old.disposeLog).toHaveLength(oldDisposeCount);
    expect(old.scheduler.pendingCount).toBe(0);

    expect(next.adapter.renderer).toBe('webgl');
    expect(nextReceipt).not.toHaveBeenCalled();
    expect(next.onData).not.toHaveBeenCalled();
    expect(next.onBinary).not.toHaveBeenCalled();
    expect(next.onResize).not.toHaveBeenCalled();
    expect(next.onRendererChange).not.toHaveBeenCalled();
    expect(next.disposeLog).toEqual([]);
    expect(next.scheduler.pendingCount).toBe(1);

    next.scheduler.flush();
    next.terminal.writes[0]?.callback?.();
    next.terminal.emitData('new');
    next.terminal.emitBinary('\u0002');
    expect(next.onResize).toHaveBeenCalledWith(80, 24);
    expect(nextReceipt).toHaveBeenCalledOnce();
    expect(next.onData).toHaveBeenCalledWith('new');
    expect(next.onBinary).toHaveBeenCalledWith('\u0002');
  });
});

describe('XtermTerminalAdapter resize coalescing', () => {
  it('fits and returns initial dimensions without sending resize before ready', () => {
    const { adapter, fitAddon, onResize, scheduler } = createHarness();
    adapter.open(createSizedElement(800, 480));

    expect(adapter.proposeDimensions()).toEqual({ cols: 80, rows: 24 });
    expect(adapter.fit()).toEqual({ cols: 80, rows: 24 });
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onResize).not.toHaveBeenCalled();

    adapter.setReady(true);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.flush();
    expect(onResize).not.toHaveBeenCalled();
  });

  it('coalesces at least 100 observer events into one bounded resize send', () => {
    const { adapter, fitAddon, onResize, resizeObserver, scheduler } = createHarness();
    adapter.open(createSizedElement(800, 480));
    adapter.setReady(true);
    scheduler.flush();
    expect(onResize).toHaveBeenLastCalledWith(80, 24);

    fitAddon.proposeDimensions.mockReturnValue({ cols: 120, rows: 40 });
    for (let index = 0; index < 150; index += 1) resizeObserver.emit();

    expect(scheduler.pendingCount).toBe(1);
    expect(onResize).toHaveBeenCalledOnce();
    scheduler.flush();
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(120, 40);
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
  });

  it('ignores nonzero observer resizes while inactive and refits on reactivation', () => {
    const { adapter, fitAddon, onResize, resizeObserver, scheduler } = createHarness();
    const element = createSizedElement(800, 480);
    adapter.open(element);
    resizeObserver.emit();
    expect(scheduler.pendingCount).toBe(0);
    expect(fitAddon.fit).not.toHaveBeenCalled();

    adapter.setReady(true);
    scheduler.flush();
    expect(onResize).toHaveBeenCalledWith(80, 24);

    adapter.setActive(false);
    fitAddon.proposeDimensions.mockReturnValue({ cols: 100, rows: 30 });
    for (let index = 0; index < 20; index += 1) resizeObserver.emit();
    expect(scheduler.pendingCount).toBe(0);
    expect(onResize).toHaveBeenCalledOnce();

    adapter.setActive(true);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.flush();
    expect(onResize).toHaveBeenLastCalledWith(100, 30);
  });

  it.each([
    [{ cols: 0, rows: 24 }, 'zero columns'],
    [{ cols: 501, rows: 24 }, 'columns above the protocol bound'],
    [{ cols: 80, rows: 0 }, 'zero rows'],
    [{ cols: 80, rows: 201 }, 'rows above the protocol bound'],
    [{ cols: 80.5, rows: 24 }, 'fractional columns'],
    [{ cols: Number.NaN, rows: 24 }, 'NaN columns'],
  ])('skips %s (%s)', (dimensions) => {
    const { adapter, fitAddon, onResize, scheduler } = createHarness();
    fitAddon.proposeDimensions.mockReturnValue(dimensions);
    adapter.open(createSizedElement(800, 480));
    adapter.setReady(true);
    scheduler.flush();

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });

  it('skips unchanged dimensions', () => {
    const { adapter, fitAddon, onResize, resizeObserver, scheduler } = createHarness();
    const element = createSizedElement(800, 480);
    adapter.open(element);
    adapter.setReady(true);
    scheduler.flush();
    expect(fitAddon.fit).toHaveBeenCalledOnce();

    resizeObserver.emit();
    scheduler.flush();
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledOnce();
  });

  it('ignores active zero-size resizes until the container becomes nonzero', () => {
    const { adapter, fitAddon, onResize, resizeObserver, scheduler } = createHarness();
    const element = createSizedElement(800, 480);
    adapter.open(element);
    adapter.setReady(true);
    scheduler.flush();
    expect(onResize).toHaveBeenCalledOnce();

    setElementSize(element, 0, 0);
    fitAddon.proposeDimensions.mockReturnValue({ cols: 100, rows: 30 });
    resizeObserver.emit();
    scheduler.flush();
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledOnce();

    setElementSize(element, 900, 600);
    resizeObserver.emit();
    scheduler.flush();
    expect(fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(100, 30);
  });

  it('invalidates cancelled frames and observer callbacks after disposal', () => {
    const old = createHarness();
    old.adapter.open(createSizedElement(800, 480));
    old.adapter.setReady(true);
    const staleFrame = old.scheduler.requestedCallbacks.get(1);
    expect(staleFrame).toBeTypeOf('function');

    old.adapter.dispose();
    const next = createHarness();
    next.adapter.open(createSizedElement(800, 480));
    next.adapter.setReady(true);
    staleFrame?.();
    old.resizeObserver.emit();

    expect(old.fitAddon.fit).not.toHaveBeenCalled();
    expect(old.onResize).not.toHaveBeenCalled();
    expect(old.scheduler.pendingCount).toBe(0);
    expect(next.fitAddon.fit).not.toHaveBeenCalled();
    expect(next.scheduler.pendingCount).toBe(1);
  });
});

describe('XtermTerminalAdapter WebGL fallback', () => {
  it('loads WebGL only after Terminal.open and records the accelerated renderer', () => {
    const harness = createHarness({
      webglAddonFactory: () => {
        expect(harness.terminal.open).toHaveBeenCalledOnce();
        return harness.webglAddon;
      },
    });

    expect(harness.adapter.renderer).toBe('dom');
    harness.adapter.open(createSizedElement(800, 480));

    expect(harness.adapter.renderer).toBe('webgl');
    expect(harness.onRendererChange).toHaveBeenCalledWith('webgl');
  });

  it('keeps the DOM terminal usable when WebGL construction fails', () => {
    const harness = createHarness({
      webglAddonFactory: () => {
        throw new Error('WebGL unavailable');
      },
    });
    const receipt = vi.fn();

    expect(() => harness.adapter.open(createSizedElement(800, 480))).not.toThrow();
    harness.adapter.setInputEnabled(true);
    harness.adapter.setReady(true);
    expect(harness.adapter.renderer).toBe('dom');
    expect(harness.disposeLog).not.toContain('terminal');
    expect(harness.adapter.fit()).toEqual({ cols: 80, rows: 24 });
    expect(harness.adapter.findNext('ready', { caseSensitive: true })).toBe(true);
    expect(harness.adapter.write(new Uint8Array([65]), receipt)).toBe(true);
    harness.terminal.writes[0]?.callback?.();
    harness.terminal.emitData('pwd\r');

    expect(receipt).toHaveBeenCalledOnce();
    expect(harness.onData).toHaveBeenCalledWith('pwd\r');
  });

  it('disposes only the failed WebGL resources when addon loading throws', () => {
    const harness = createHarness();
    harness.terminal.failLoadFor = harness.webglAddon;

    expect(() => harness.adapter.open(createSizedElement(800, 480))).not.toThrow();
    expect(harness.adapter.renderer).toBe('dom');
    expect(harness.disposeLog).toEqual(['webgl-context-listener', 'webgl']);
    expect(harness.terminal.loadedAddons).toEqual([
      harness.fitAddon,
      harness.searchAddon,
    ]);
    expect(harness.adapter.findPrevious('fallback')).toBe(true);
    harness.adapter.clearSearch();
    harness.adapter.clear();
    expect(harness.searchAddon.clearDecorations).toHaveBeenCalledOnce();
    expect(harness.terminal.clear).toHaveBeenCalledOnce();
  });

  it('falls back idempotently on context loss without disposing Terminal', () => {
    const harness = createHarness();
    const receipt = vi.fn();
    harness.adapter.open(createSizedElement(800, 480));
    harness.adapter.setReady(true);
    harness.disposeLog.length = 0;
    harness.onRendererChange.mockClear();

    harness.webglAddon.loseContext();
    harness.webglAddon.loseContext();

    expect(harness.adapter.renderer).toBe('dom');
    expect(harness.disposeLog).toEqual(['webgl-context-listener', 'webgl']);
    expect(harness.onRendererChange).toHaveBeenCalledOnce();
    expect(harness.onRendererChange).toHaveBeenCalledWith('dom');
    expect(harness.adapter.findNext('still-works')).toBe(true);
    expect(harness.adapter.write(new Uint8Array([66]), receipt)).toBe(true);
    harness.terminal.writes[0]?.callback?.();
    expect(receipt).toHaveBeenCalledOnce();
    expect(harness.disposeLog).not.toContain('terminal');
  });
});
