import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isRunLockingState, isRunTerminalState, type RunId, type RunSummary } from '../../contracts/run';
import { requireTerminalRun, useActiveRunQuery } from './runQueries';

export type RunAuthorityPhase =
  | 'LOADING_AUTHORITY'
  | 'EDITABLE'
  | 'RELOADING_WORKSPACE'
  | 'RELOAD_FAILED';

export type RunAuthoritySnapshot = {
  phase: RunAuthorityPhase;
  startPending: boolean;
  observedLockingRunId: RunId | null;
};

export type FetchRunDetail = (runId: RunId, signal?: AbortSignal) => Promise<RunSummary>;

export function isWorkspaceEditable(snapshot: RunAuthoritySnapshot): boolean {
  return (
    snapshot.phase === 'EDITABLE' &&
    !snapshot.startPending &&
    snapshot.observedLockingRunId === null
  );
}

const INITIAL_SNAPSHOT: RunAuthoritySnapshot = {
  phase: 'LOADING_AUTHORITY',
  startPending: false,
  observedLockingRunId: null,
};

export class RunAuthorityCoordinator {
  readonly projectId: string;
  private fetchRun: FetchRunDetail;
  private snapshot: RunAuthoritySnapshot = { ...INITIAL_SNAPSHOT };
  private readonly listeners = new Set<() => void>();
  private confirmGeneration = 0;
  private confirmingRunId: RunId | null = null;

  constructor(options: { projectId: string; fetchRun: FetchRunDetail }) {
    this.projectId = options.projectId;
    this.fetchRun = options.fetchRun;
  }

  setFetchRun(fetchRun: FetchRunDetail): void {
    this.fetchRun = fetchRun;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RunAuthoritySnapshot => this.snapshot;

  noteStartPending(): void {
    if (this.snapshot.startPending) {
      return;
    }
    this.patch({ startPending: true });
  }

  clearStartPending(): void {
    if (!this.snapshot.startPending) {
      return;
    }
    this.patch({ startPending: false });
  }

  markReloadFailed(): void {
    if (this.snapshot.phase !== 'RELOADING_WORKSPACE' && this.snapshot.phase !== 'RELOAD_FAILED') {
      return;
    }
    this.patch({ phase: 'RELOAD_FAILED' });
  }

  async reconcile(status: 'pending' | 'error' | 'success', run: RunSummary | null): Promise<void> {
    if (status === 'pending' || status === 'error') {
      return;
    }
    if (run !== null && isRunLockingState(run.state)) {
      const observedChanged = this.snapshot.observedLockingRunId !== run.id;
      if (observedChanged) {
        this.confirmGeneration += 1;
        this.confirmingRunId = null;
      }
      const next: Partial<RunAuthoritySnapshot> = { observedLockingRunId: run.id };
      if (this.snapshot.phase === 'LOADING_AUTHORITY') {
        next.phase = 'EDITABLE';
      } else if (
        observedChanged &&
        (this.snapshot.phase === 'RELOADING_WORKSPACE' || this.snapshot.phase === 'RELOAD_FAILED')
      ) {
        next.phase = 'EDITABLE';
      }
      if (observedChanged || next.phase !== undefined) {
        this.patch(next);
      }
      return;
    }
    if (run !== null) {
      return;
    }
    const observed = this.snapshot.observedLockingRunId;
    if (observed === null) {
      if (this.snapshot.phase === 'LOADING_AUTHORITY') {
        this.patch({ phase: 'EDITABLE' });
      }
      return;
    }
    if (this.snapshot.phase === 'RELOADING_WORKSPACE' || this.snapshot.phase === 'RELOAD_FAILED') {
      return;
    }
    await this.confirmTerminal(observed);
  }

  private async confirmTerminal(runId: RunId): Promise<void> {
    if (this.confirmingRunId === runId) {
      return;
    }
    this.confirmingRunId = runId;
    const generation = this.confirmGeneration + 1;
    this.confirmGeneration = generation;
    try {
      const detail = await this.fetchRun(runId);
      if (generation !== this.confirmGeneration) {
        return;
      }
      if (this.snapshot.observedLockingRunId !== runId) {
        return;
      }
      if (!isRunTerminalState(detail.state)) {
        return;
      }
      this.patch({ phase: 'RELOADING_WORKSPACE' });
    } catch {
      // Fail closed: a missing/locking/invalid detail never unlocks.
    } finally {
      if (this.confirmingRunId === runId) {
        this.confirmingRunId = null;
      }
    }
  }

  private patch(partial: Partial<RunAuthoritySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function useRunAuthorityCoordinator(projectId: string): RunAuthorityCoordinator {
  const coordinatorRef = useRef<RunAuthorityCoordinator | null>(null);
  if (coordinatorRef.current === null || coordinatorRef.current.projectId !== projectId) {
    coordinatorRef.current = new RunAuthorityCoordinator({
      projectId,
      fetchRun: (runId, signal) => requireTerminalRun(projectId, runId, signal),
    });
  } else {
    coordinatorRef.current.setFetchRun((runId, signal) => requireTerminalRun(projectId, runId, signal));
  }
  const coordinator = coordinatorRef.current;
  const snapshot = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const unconfirmedLock =
    snapshot.observedLockingRunId !== null &&
    snapshot.phase !== 'RELOADING_WORKSPACE' &&
    snapshot.phase !== 'RELOAD_FAILED';
  const active = useActiveRunQuery(projectId, unconfirmedLock);

  useEffect(() => {
    const status = active.status === 'pending' || active.status === 'error' ? active.status : 'success';
    void coordinator.reconcile(status, active.data?.run ?? null);
  }, [active.data, active.dataUpdatedAt, active.status, coordinator]);

  return coordinator;
}
