import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITerminalAddon, type ITerminalOptions } from '@xterm/xterm';

export type XtermDisposable = {
  dispose(): void;
};

export type XtermAddonPort = XtermDisposable;

export type XtermTerminalPort = {
  readonly cols: number;
  readonly rows: number;
  readonly options: { disableStdin?: boolean };
  open(element: HTMLElement): void;
  focus(): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(listener: (data: string) => void): XtermDisposable;
  onBinary(listener: (data: string) => void): XtermDisposable;
  loadAddon(addon: XtermAddonPort): void;
  clear(): void;
  dispose(): void;
};

export type XtermFitAddonPort = XtermAddonPort & {
  fit(): void;
  proposeDimensions(): { cols: number; rows: number } | undefined;
};

export type XtermDimensions = { cols: number; rows: number };
export type XtermRenderer = 'webgl' | 'dom';

export type XtermSearchOptions = Pick<
  ISearchOptions,
  'caseSensitive' | 'wholeWord' | 'regex'
>;

export type XtermSearchAddonPort = XtermAddonPort & {
  findNext(term: string, options?: XtermSearchOptions): boolean;
  findPrevious(term: string, options?: XtermSearchOptions): boolean;
  clearDecorations(): void;
};

export type XtermWebglAddonPort = XtermAddonPort & {
  onContextLoss(listener: () => void): XtermDisposable;
};

export type XtermResizeObserverPort = {
  observe(element: Element): void;
  disconnect(): void;
};

export type XtermAnimationFrameScheduler = {
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(id: unknown): void;
};

export type XtermTerminalAdapterOptions = {
  onData?: (data: string) => void;
  onBinary?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRendererChange?: (renderer: XtermRenderer) => void;
  scheduler?: XtermAnimationFrameScheduler;
  terminalFactory?: () => XtermTerminalPort;
  fitAddonFactory?: () => XtermFitAddonPort;
  searchAddonFactory?: () => XtermSearchAddonPort;
  webglAddonFactory?: () => XtermWebglAddonPort;
  resizeObserverFactory?: (listener: () => void) => XtermResizeObserverPort;
};

type OwnedResource = {
  active: boolean;
  readonly dispose: () => void;
};

type PendingWrite = {
  parsed: boolean;
  readonly receipt: () => void;
};

const terminalOptions: ITerminalOptions = {
  convertEol: false,
  cursorStyle: 'bar',
  disableStdin: true,
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  scrollback: 5_000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
};

function createBrowserTerminal(): XtermTerminalPort {
  const reducedMotion = typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const terminal = new Terminal({ ...terminalOptions, cursorBlink: !reducedMotion });
  return {
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    get options() {
      return terminal.options;
    },
    open: (element) => terminal.open(element),
    focus: () => terminal.focus(),
    write: (data, callback) => terminal.write(data, callback),
    onData: (listener) => terminal.onData(listener),
    onBinary: (listener) => terminal.onBinary(listener),
    loadAddon: (addon) => terminal.loadAddon(addon as ITerminalAddon),
    clear: () => terminal.clear(),
    dispose: () => terminal.dispose(),
  };
}

function createBrowserResizeObserver(listener: () => void): XtermResizeObserverPort {
  return new ResizeObserver(listener);
}

const browserAnimationFrameScheduler: XtermAnimationFrameScheduler = {
  requestAnimationFrame: (callback) => requestAnimationFrame(() => callback()),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id as number),
};

function isValidDimensions(value: XtermDimensions | undefined): value is XtermDimensions {
  return (
    value !== undefined &&
    Number.isSafeInteger(value.cols) &&
    value.cols >= 2 &&
    value.cols <= 500 &&
    Number.isSafeInteger(value.rows) &&
    value.rows >= 1 &&
    value.rows <= 200
  );
}

function sameDimensions(
  left: XtermDimensions | null,
  right: XtermDimensions,
): boolean {
  return left?.cols === right.cols && left.rows === right.rows;
}

export class XtermTerminalAdapter {
  private terminal: XtermTerminalPort | null = null;
  private fitAddon: XtermFitAddonPort | null = null;
  private searchAddon: XtermSearchAddonPort | null = null;
  private webglResource: OwnedResource | null = null;
  private webglContextLossResource: OwnedResource | null = null;
  private readonly ownedResources: OwnedResource[] = [];
  private readonly pendingWrites: PendingWrite[] = [];
  private readonly onData: ((data: string) => void) | undefined;
  private readonly onBinary: ((data: string) => void) | undefined;
  private readonly onResize: ((cols: number, rows: number) => void) | undefined;
  private readonly onRendererChange: ((renderer: XtermRenderer) => void) | undefined;
  private readonly scheduler: XtermAnimationFrameScheduler;
  private readonly webglAddonFactory: () => XtermWebglAddonPort;
  private readonly resizeObserverFactory: (listener: () => void) => XtermResizeObserverPort;
  private generation = 1;
  private container: HTMLElement | null = null;
  private pendingFrame: unknown = null;
  private lastDimensions: { cols: number; rows: number } | null = null;
  private opened = false;
  private ready = false;
  private active = true;
  private inputRequested = false;
  private currentRenderer: XtermRenderer = 'dom';
  private disposed = false;

  constructor(options: XtermTerminalAdapterOptions = {}) {
    this.onData = options.onData;
    this.onBinary = options.onBinary;
    this.onResize = options.onResize;
    this.onRendererChange = options.onRendererChange;
    this.scheduler = options.scheduler ?? browserAnimationFrameScheduler;
    this.webglAddonFactory = options.webglAddonFactory ?? (() => new WebglAddon());
    this.resizeObserverFactory =
      options.resizeObserverFactory ?? createBrowserResizeObserver;

    try {
      const terminal = (options.terminalFactory ?? createBrowserTerminal)();
      this.terminal = terminal;
      this.own(terminal);

      const fitAddon = (options.fitAddonFactory ?? (() => new FitAddon()))();
      this.fitAddon = fitAddon;
      this.own(fitAddon);
      terminal.loadAddon(fitAddon);

      const searchAddon = (options.searchAddonFactory ?? (() => new SearchAddon()))();
      this.searchAddon = searchAddon;
      this.own(searchAddon);
      terminal.loadAddon(searchAddon);

      const generation = this.generation;
      this.own(
        terminal.onData((data) => {
          if (this.acceptsInput(generation)) this.onData?.(data);
        }),
      );
      this.own(
        terminal.onBinary((data) => {
          if (this.acceptsInput(generation)) this.onBinary?.(data);
        }),
      );
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  open(element: HTMLElement): void {
    this.assertLive();
    if (this.opened) throw new Error('Terminal is already open');
    const terminal = this.requireTerminal();
    const generation = this.generation;
    try {
      terminal.open(element);
      this.opened = true;
      this.container = element;
      const observer = this.resizeObserverFactory(() => {
        if (!this.isCurrent(generation)) return;
        this.scheduleFit();
      });
      this.own({ dispose: () => observer.disconnect() });
      observer.observe(element);
    } catch (error) {
      this.dispose();
      throw error;
    }
    this.loadWebgl(generation, terminal);
  }

  get renderer(): XtermRenderer {
    return this.currentRenderer;
  }

  setReady(ready: boolean): void {
    if (this.disposed) return;
    this.ready = ready && this.opened;
    this.applyInputState();
    if (!this.ready) {
      this.cancelPendingFrame();
      return;
    }
    if (this.active) this.terminal?.focus();
    this.scheduleFit();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    this.applyInputState();
    if (!active) {
      this.cancelPendingFrame();
      return;
    }
    if (this.ready) this.terminal?.focus();
    this.scheduleFit();
  }

  focus(): void {
    if (!this.disposed && this.opened && this.ready && this.active) {
      this.terminal?.focus();
    }
  }

  proposeDimensions(): XtermDimensions | null {
    if (this.disposed || !this.opened || !this.active || !this.container || !this.fitAddon) {
      return null;
    }
    if (this.container.clientWidth <= 0 || this.container.clientHeight <= 0) return null;
    try {
      const dimensions = this.fitAddon.proposeDimensions();
      return isValidDimensions(dimensions) ? dimensions : null;
    } catch {
      return null;
    }
  }

  fit(): XtermDimensions | null {
    const dimensions = this.proposeDimensions();
    if (!dimensions) return null;
    if (sameDimensions(this.lastDimensions, dimensions)) return dimensions;
    try {
      this.fitAddon?.fit();
    } catch {
      return null;
    }
    this.lastDimensions = dimensions;
    return dimensions;
  }

  findNext(term: string, options?: XtermSearchOptions): boolean {
    if (this.disposed || !this.opened || term === '') return false;
    try {
      return this.searchAddon?.findNext(term, options) ?? false;
    } catch {
      return false;
    }
  }

  findPrevious(term: string, options?: XtermSearchOptions): boolean {
    if (this.disposed || !this.opened || term === '') return false;
    try {
      return this.searchAddon?.findPrevious(term, options) ?? false;
    } catch {
      return false;
    }
  }

  clearSearch(): void {
    if (this.disposed) return;
    try {
      this.searchAddon?.clearDecorations();
    } catch {
      // Search decoration cleanup is best effort.
    }
  }

  clear(): void {
    if (this.disposed || !this.opened) return;
    try {
      this.terminal?.clear();
    } catch {
      // Clearing the viewport cannot break session ownership.
    }
  }

  setInputEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.inputRequested = enabled;
    this.applyInputState();
  }

  write(data: Uint8Array, receipt: () => void): boolean {
    if (this.disposed || !this.opened || !this.ready) return false;
    const terminal = this.requireTerminal();
    const generation = this.generation;
    const pending: PendingWrite = { parsed: false, receipt };
    this.pendingWrites.push(pending);
    try {
      terminal.write(data, () => {
        if (!this.isCurrent(generation)) return;
        pending.parsed = true;
        this.flushParsedWrites();
      });
      return true;
    } catch {
      const index = this.pendingWrites.indexOf(pending);
      if (index >= 0) this.pendingWrites.splice(index, 1);
      return false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.cancelPendingFrame();
    this.ready = false;
    this.inputRequested = false;
    this.pendingWrites.length = 0;
    try {
      if (this.terminal) this.terminal.options.disableStdin = true;
    } catch {
      // Resource teardown continues even when xterm rejects an option update.
    }
    for (let index = this.ownedResources.length - 1; index >= 0; index -= 1) {
      const resource = this.ownedResources[index];
      if (!resource?.active) continue;
      resource.active = false;
      try {
        resource.dispose();
      } catch {
        // Every owned browser resource still gets a teardown attempt.
      }
    }
    this.ownedResources.length = 0;
    this.container = null;
    this.fitAddon = null;
    this.searchAddon = null;
    this.webglContextLossResource = null;
    this.webglResource = null;
    this.terminal = null;
  }

  private own(resource: XtermDisposable): OwnedResource {
    const owned = { active: true, dispose: () => resource.dispose() };
    this.ownedResources.push(owned);
    return owned;
  }

  private loadWebgl(generation: number, terminal: XtermTerminalPort): void {
    try {
      const addon = this.webglAddonFactory();
      const addonResource = this.own(addon);
      this.webglResource = addonResource;
      const contextLossResource = this.own(
        addon.onContextLoss(() => {
          if (this.isCurrent(generation)) this.fallbackFromWebgl();
        }),
      );
      this.webglContextLossResource = contextLossResource;
      terminal.loadAddon(addon);
      if (this.webglResource === addonResource && addonResource.active) {
        this.setRenderer('webgl');
      }
    } catch {
      this.fallbackFromWebgl();
    }
  }

  private fallbackFromWebgl(): void {
    this.disposeOwned(this.webglContextLossResource);
    this.webglContextLossResource = null;
    this.disposeOwned(this.webglResource);
    this.webglResource = null;
    this.setRenderer('dom');
  }

  private disposeOwned(resource: OwnedResource | null): void {
    if (!resource?.active) return;
    resource.active = false;
    try {
      resource.dispose();
    } catch {
      // Fallback and full teardown continue through independent resources.
    }
  }

  private setRenderer(renderer: XtermRenderer): void {
    if (this.currentRenderer === renderer) return;
    this.currentRenderer = renderer;
    try {
      this.onRendererChange?.(renderer);
    } catch {
      // Renderer observers cannot interrupt fallback.
    }
  }

  private scheduleFit(): void {
    if (
      this.disposed ||
      !this.opened ||
      !this.ready ||
      !this.active ||
      this.pendingFrame !== null
    ) {
      return;
    }
    const generation = this.generation;
    this.pendingFrame = this.scheduler.requestAnimationFrame(() => {
      if (!this.isCurrent(generation)) return;
      this.pendingFrame = null;
      if (!this.ready || !this.active) return;
      const previous = this.lastDimensions;
      const dimensions = this.fit();
      if (!dimensions || sameDimensions(previous, dimensions)) return;
      try {
        this.onResize?.(dimensions.cols, dimensions.rows);
      } catch {
        // Resize observers cannot interrupt the adapter lifecycle.
      }
    });
  }

  private cancelPendingFrame(): void {
    if (this.pendingFrame === null) return;
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    try {
      this.scheduler.cancelAnimationFrame(frame);
    } catch {
      // Generation checks still invalidate a frame the browser cannot cancel.
    }
  }

  private acceptsInput(generation: number): boolean {
    return this.isCurrent(generation) && this.ready && this.active && this.inputRequested;
  }

  private applyInputState(): void {
    if (this.terminal) {
      this.terminal.options.disableStdin = !(this.ready && this.active && this.inputRequested);
    }
  }

  private flushParsedWrites(): void {
    while (this.pendingWrites[0]?.parsed) {
      const pending = this.pendingWrites.shift();
      try {
        pending?.receipt();
      } catch {
        // A receipt observer cannot block acknowledgements for later writes.
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Terminal adapter is disposed');
  }

  private requireTerminal(): XtermTerminalPort {
    if (!this.terminal) throw new Error('Terminal adapter is disposed');
    return this.terminal;
  }
}
