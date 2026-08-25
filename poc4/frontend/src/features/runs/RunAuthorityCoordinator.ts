import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import {
  isRunLockingState,
  isRunTerminalState,
  type RunId,
  type RunState,
  type RunSummary,
} from '../../contracts/run';
import { cacheRunSummary, requireTerminalRun, useActiveRunQuery } from './runQueries';

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

export type TerminalRunAuthority = { id: RunId; state: RunState };

export type TerminalAuthoritySnapshot = {
  status: 'pending' | 'error' | 'success';
  run: TerminalRunAuthority | null;
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

const INITIAL_TERMINAL_AUTHORITY_SNAPSHOT: TerminalAuthoritySnapshot = {
  status: 'pending',
  run: null,
};

export class RunAuthorityCoordinator {
  readonly projectId: string;
  private fetchRun: FetchRunDetail;
  private snapshot: RunAuthoritySnapshot = { ...INITIAL_SNAPSHOT };
  private terminalAuthoritySnapshot: TerminalAuthoritySnapshot = {
    ...INITIAL_TERMINAL_AUTHORITY_SNAPSHOT,
  };
  private readonly listeners = new Set<() => void>();
  private readonly terminalAuthorityListeners = new Set<() => void>();
  private confirmGeneration = 0;
  private confirmingRunId: RunId | null = null;
  private reloadGeneration = 0;

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

  subscribeTerminalAuthority = (listener: () => void): (() => void) => {
    this.terminalAuthorityListeners.add(listener);
    return () => {
      this.terminalAuthorityListeners.delete(listener);
    };
  };

  getTerminalAuthoritySnapshot = (): TerminalAuthoritySnapshot =>
    this.terminalAuthoritySnapshot;

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

  getReloadGeneration(): number {
    return this.reloadGeneration;
  }

  markReloadFailed(): void {
    if (this.snapshot.phase !== 'RELOADING_WORKSPACE' && this.snapshot.phase !== 'RELOAD_FAILED') {
      return;
    }
    this.patch({ phase: 'RELOAD_FAILED' });
  }

  completeReload(): void {
    if (this.snapshot.phase !== 'RELOADING_WORKSPACE') {
      return;
    }
    this.publishTerminalAuthority('success', null);
    this.patch({ phase: 'EDITABLE', observedLockingRunId: null });
  }

  retryReload(): void {
    if (this.snapshot.phase !== 'RELOAD_FAILED') {
      return;
    }
    this.enterReloading();
  }

  async reconcile(status: 'pending' | 'error' | 'success', run: RunSummary | null): Promise<void> {
    if (status === 'pending') {
      this.publishTerminalAuthority('pending', null);
      return;
    }
    if (status === 'error') {
      this.publishTerminalAuthority('error', null);
      if (this.snapshot.phase === 'EDITABLE') {
        this.patch({ phase: 'LOADING_AUTHORITY' });
      }
      return;
    }
    if (run !== null && isRunLockingState(run.state)) {
      this.publishTerminalAuthority('success', run);
      const observedChanged = this.snapshot.observedLockingRunId !== run.id;
      if (observedChanged || this.confirmingRunId !== null) {
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
      this.publishTerminalAuthority('success', run);
      return;
    }
    const observed = this.snapshot.observedLockingRunId;
    if (observed === null) {
      this.publishTerminalAuthority('success', null);
      if (this.snapshot.phase === 'LOADING_AUTHORITY') {
        this.patch({ phase: 'EDITABLE' });
      }
      return;
    }
    if (this.snapshot.phase === 'RELOADING_WORKSPACE' || this.snapshot.phase === 'RELOAD_FAILED') {
      return;
    }
    this.publishTerminalAuthority('success', null);
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
      this.publishTerminalAuthority('success', detail);
      this.enterReloading();
    } catch {
      // Fail closed: a missing/locking/invalid detail never unlocks.
    } finally {
      if (this.confirmingRunId === runId) {
        this.confirmingRunId = null;
      }
    }
  }

  private publishTerminalAuthority(
    status: TerminalAuthoritySnapshot['status'],
    run: TerminalRunAuthority | null,
  ): void {
    const current = this.terminalAuthoritySnapshot;
    if (
      current.status === status &&
      current.run?.id === run?.id &&
      current.run?.state === run?.state
    ) {
      return;
    }
    this.terminalAuthoritySnapshot = {
      status,
      run: run === null ? null : { id: run.id, state: run.state },
    };
    for (const listener of this.terminalAuthorityListeners) {
      listener();
    }
  }

  private enterReloading(): void {
    this.reloadGeneration += 1;
    this.patch({ phase: 'RELOADING_WORKSPACE' });
  }

  private patch(partial: Partial<RunAuthoritySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function useRunAuthorityCoordinator(projectId: string): RunAuthorityCoordinator {
  const queryClient = useQueryClient();
  const coordinatorRef = useRef<RunAuthorityCoordinator | null>(null);
  const fetchRun: FetchRunDetail = async (runId, signal) => {
    const detail = await requireTerminalRun(projectId, runId, signal);
    cacheRunSummary(queryClient, projectId, detail);
    return detail;
  };
  if (coordinatorRef.current === null || coordinatorRef.current.projectId !== projectId) {
    coordinatorRef.current = new RunAuthorityCoordinator({
      projectId,
      fetchRun,
    });
  } else {
    coordinatorRef.current.setFetchRun(fetchRun);
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
