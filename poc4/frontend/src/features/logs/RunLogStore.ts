import type { LogChunk, LogWindowMeta } from '../../contracts/log';
import type { RunId } from '../../contracts/run';

export type RunLogConnection =
  | 'idle'
  | 'ticketing'
  | 'connecting'
  | 'replaying'
  | 'live'
  | 'reconnecting'
  | 'complete'
  | 'failed';

export type RunLogSnapshot = {
  projectId: string;
  runId: RunId;
  chunks: readonly LogChunk[];
  lastAppliedSeq: number | null;
  window: LogWindowMeta;
  connection: RunLogConnection;
  pendingOutput: boolean;
  error: string | null;
};

export type NotificationScheduler = (notify: () => void) => () => void;

export const EMPTY_LOG_WINDOW: LogWindowMeta = {
  firstAvailableSeq: null,
  lastAvailableSeq: null,
  retainedBytes: 0,
  truncated: false,
  evictedBytes: 0,
};

export function runLogStoreKey(projectId: string, runId: RunId): string {
  return `${projectId.length}:${projectId}:${runId}`;
}

function defaultSchedule(notify: () => void): () => void {
  const id = requestAnimationFrame(notify);
  return () => {
    cancelAnimationFrame(id);
  };
}

function sameWindow(left: LogWindowMeta, right: LogWindowMeta): boolean {
  return (
    left.firstAvailableSeq === right.firstAvailableSeq &&
    left.lastAvailableSeq === right.lastAvailableSeq &&
    left.retainedBytes === right.retainedBytes &&
    left.truncated === right.truncated &&
    left.evictedBytes === right.evictedBytes
  );
}

function sameChunkList(left: readonly LogChunk[], right: readonly LogChunk[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

export class RunLogStore {
  readonly projectId: string;
  readonly runId: RunId;
  private snapshot: RunLogSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly scheduleNotify: NotificationScheduler;
  private cancelScheduled: (() => void) | null = null;
  private disposed = false;

  constructor(options: { projectId: string; runId: RunId; schedule?: NotificationScheduler }) {
    this.projectId = options.projectId;
    this.runId = options.runId;
    this.scheduleNotify = options.schedule ?? defaultSchedule;
    this.snapshot = {
      projectId: options.projectId,
      runId: options.runId,
      chunks: [],
      lastAppliedSeq: null,
      window: EMPTY_LOG_WINDOW,
      connection: 'idle',
      pendingOutput: false,
      error: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RunLogSnapshot => this.snapshot;

  applyReplay(chunks: readonly LogChunk[], window: LogWindowMeta): void {
    this.applyChunks(chunks, window);
  }

  applyAppend(chunk: LogChunk, window: LogWindowMeta): void {
    this.applyChunks([chunk], window);
  }

  applyWindow(window: LogWindowMeta): void {
    this.applyChunks([], window);
  }

  setConnection(connection: RunLogConnection): void {
    this.commit({ connection });
  }

  setError(error: string | null): void {
    this.commit({ error });
  }

  setPendingOutput(pendingOutput: boolean): void {
    this.commit({ pendingOutput });
  }

  markComplete(): void {
    this.commit({ connection: 'complete', error: null });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.listeners.clear();
  }

  private applyChunks(incoming: readonly LogChunk[], window: LogWindowMeta): void {
    let lastAppliedSeq = this.snapshot.lastAppliedSeq;
    const additions: LogChunk[] = [];
    for (const item of incoming) {
      if (lastAppliedSeq !== null && item.seq <= lastAppliedSeq) {
        continue;
      }
      additions.push(item);
      lastAppliedSeq = item.seq;
    }
    const combined =
      additions.length === 0 ? this.snapshot.chunks : [...this.snapshot.chunks, ...additions];
    const firstAvailableSeq = window.firstAvailableSeq;
    const retained =
      firstAvailableSeq === null ? [] : combined.filter((item) => item.seq >= firstAvailableSeq);
    this.commit({
      chunks: sameChunkList(this.snapshot.chunks, retained) ? this.snapshot.chunks : retained,
      lastAppliedSeq,
      window,
    });
  }

  private commit(partial: Partial<RunLogSnapshot>): void {
    if (this.disposed) {
      return;
    }
    const next: RunLogSnapshot = { ...this.snapshot, ...partial };
    if (
      next.connection === this.snapshot.connection &&
      next.error === this.snapshot.error &&
      next.pendingOutput === this.snapshot.pendingOutput &&
      next.lastAppliedSeq === this.snapshot.lastAppliedSeq &&
      next.chunks === this.snapshot.chunks &&
      sameWindow(next.window, this.snapshot.window)
    ) {
      return;
    }
    this.snapshot = next;
    if (this.cancelScheduled !== null) {
      return;
    }
    this.cancelScheduled = this.scheduleNotify(() => {
      this.cancelScheduled = null;
      if (this.disposed) {
        return;
      }
      for (const listener of [...this.listeners]) {
        listener();
      }
    });
  }
}
