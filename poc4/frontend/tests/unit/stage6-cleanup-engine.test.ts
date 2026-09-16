import { describe, expect, it, vi } from 'vitest';
import type {
  CleanupClock,
  CleanupEntry,
  CleanupLedger,
  CleanupTransport,
  ProjectView,
} from '../support/stage6-cleanup/contracts.ts';
import { DEFAULT_CLEANUP_POLICY } from '../support/stage6-cleanup/contracts.ts';
import { isCreateTransportUncertainty, Stage6CleanupEngine } from '../support/stage6-cleanup/engine.ts';

function baseEntry(overrides: Partial<CleanupEntry> = {}): CleanupEntry {
  return {
    schemaVersion: 1,
    invocationId: 'inv-1',
    testId: 'case-1',
    attempt: 0,
    workerKey: 'worker-1',
    entryId: 'entry-1',
    ownerId: 'owner-a',
    ownerKey: 'alice',
    exactName: 'stage6-inv-1-case-1',
    preparedAt: '2026-09-10T00:00:00.000Z',
    projectId: null,
    runIds: [],
    state: 'PREPARED',
    issueCodes: [],
    ...overrides,
  };
}

function memoryLedger(saved: CleanupEntry[] = []): CleanupLedger {
  return {
    write: async (value) => {
      saved.push(structuredClone(value));
    },
    readAll: async () => saved.map((row) => structuredClone(row)),
  };
}

function clockAt(start: number): CleanupClock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    advance(ms) {
      now += ms;
    },
  };
}

function transport(partial: Partial<CleanupTransport>): CleanupTransport {
  return {
    verifyOwner: vi.fn().mockResolvedValue(undefined),
    createProject: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn(),
    deleteProject: vi.fn(),
    getActiveRun: vi.fn().mockResolvedValue(null),
    stopRun: vi.fn(),
    ...partial,
  };
}

describe('Stage6CleanupEngine.createRegistered', () => {
  it('reconciles a lost create response without another POST', async () => {
    const entry = baseEntry();
    const project: ProjectView = {
      id: 'p1',
      name: entry.exactName,
      state: 'CREATING',
      createdAt: entry.preparedAt,
    };
    const saved: CleanupEntry[] = [];
    const createProject = vi.fn().mockRejectedValue(new Error('TRANSPORT_UNCERTAIN'));
    const engine = new Stage6CleanupEngine(
      memoryLedger(saved),
      transport({
        createProject,
        listProjects: vi.fn().mockResolvedValue([project]),
      }),
      clockAt(Date.parse(entry.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await engine.createRegistered(entry)).id).toBe('p1');
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(saved[0]?.state).toBe('PREPARED');
    expect(saved.at(-1)?.projectId).toBe('p1');
  });

  it('does not POST when ledger write of the intent fails', async () => {
    const createProject = vi.fn();
    const engine = new Stage6CleanupEngine(
      {
        write: async () => {
          throw new Error('disk full');
        },
        readAll: async () => [],
      },
      transport({ createProject }),
      clockAt(Date.parse(baseEntry().preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    await expect(engine.createRegistered(baseEntry())).rejects.toThrow('disk full');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('waits for an empty list then a unique match and rejects ambiguous names', async () => {
    const entry = baseEntry();
    const project: ProjectView = {
      id: 'p1',
      name: entry.exactName,
      state: 'READY',
      createdAt: entry.preparedAt,
    };
    const listProjects = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project]);
    const engine = new Stage6CleanupEngine(
      memoryLedger(),
      transport({
        createProject: vi.fn().mockRejectedValue(new Error('TRANSPORT_UNCERTAIN')),
        listProjects,
      }),
      clockAt(Date.parse(entry.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await engine.createRegistered(entry)).id).toBe('p1');
    expect(listProjects).toHaveBeenCalledTimes(2);

    const ambiguous = new Stage6CleanupEngine(
      memoryLedger(),
      transport({
        createProject: vi.fn().mockRejectedValue(new Error('TRANSPORT_UNCERTAIN')),
        listProjects: vi.fn().mockResolvedValue([
          project,
          { ...project, id: 'p2' },
        ]),
      }),
      clockAt(Date.parse(entry.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    await expect(ambiguous.createRegistered(entry)).rejects.toThrow('CREATE_IDENTITY_AMBIGUOUS');
  });

  it('does not treat definite create HTTP errors as a lost response', async () => {
    expect(isCreateTransportUncertainty(new Error('CREATE_REJECTED:409'))).toBe(false);
    expect(isCreateTransportUncertainty(new Error('CREATE_REJECTED:400'))).toBe(false);
    expect(isCreateTransportUncertainty(new Error('AUTH_FAILED'))).toBe(false);
    expect(isCreateTransportUncertainty(new Error('TRANSPORT_UNCERTAIN'))).toBe(true);
    expect(isCreateTransportUncertainty(new Error('CREATE_REJECTED:503'))).toBe(true);
    expect(isCreateTransportUncertainty(new Error('fetch failed'))).toBe(true);

    const entry = baseEntry();
    const saved: CleanupEntry[] = [];
    const listProjects = vi.fn().mockResolvedValue([]);
    const engine = new Stage6CleanupEngine(
      memoryLedger(saved),
      transport({
        createProject: vi.fn().mockRejectedValue(new Error('CREATE_REJECTED:409')),
        listProjects,
      }),
      clockAt(Date.parse(entry.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    await expect(engine.createRegistered(entry)).rejects.toThrow('CREATE_REJECTED:409');
    expect(listProjects).not.toHaveBeenCalled();
    expect(saved.map((row) => row.state)).toEqual(['PREPARED']);
    expect(saved.some((row) => row.issueCodes.includes('CREATE_RESPONSE_UNCERTAIN'))).toBe(false);
  });
});

describe('Stage6CleanupEngine.cleanupOne and sweep', () => {
  it('marks API_CLEANED after 204 or a lost DELETE that GET reports as 404', async () => {
    const owned = baseEntry({ projectId: 'p1', state: 'OWNED' });
    const saved = [owned];
    const first = new Stage6CleanupEngine(
      memoryLedger(saved),
      transport({
        getProject: vi.fn()
          .mockResolvedValueOnce({
            status: 200,
            project: { id: 'p1', name: owned.exactName, state: 'READY', createdAt: owned.preparedAt },
          })
          .mockResolvedValueOnce({ status: 404 }),
        deleteProject: vi.fn().mockResolvedValue({ status: 204 }),
      }),
      clockAt(Date.parse(owned.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await first.cleanupOne(owned)).state).toBe('API_CLEANED');

    const lost = new Stage6CleanupEngine(
      memoryLedger([owned]),
      transport({
        getProject: vi.fn()
          .mockResolvedValueOnce({
            status: 200,
            project: { id: 'p1', name: owned.exactName, state: 'READY', createdAt: owned.preparedAt },
          })
          .mockResolvedValueOnce({ status: 404 }),
        deleteProject: vi.fn().mockRejectedValue(new Error('TRANSPORT_UNCERTAIN')),
      }),
      clockAt(Date.parse(owned.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await lost.cleanupOne(owned)).state).toBe('API_CLEANED');
  });

  it('does not cancel CREATING, stop unknown runs, or delete HELD entries', async () => {
    const creating = baseEntry({ projectId: 'p1', state: 'OWNED' });
    const creatingEngine = new Stage6CleanupEngine(
      memoryLedger([creating]),
      transport({
        getProject: vi.fn().mockResolvedValue({
          status: 200,
          project: { id: 'p1', name: creating.exactName, state: 'CREATING', createdAt: creating.preparedAt },
        }),
        deleteProject: vi.fn(),
      }),
      clockAt(Date.parse(creating.preparedAt)),
      { ...DEFAULT_CLEANUP_POLICY, creatingWaitMs: 500, projectDeadlineMs: 500 },
    );
    const creatingResult = await creatingEngine.cleanupOne(creating);
    expect(creatingResult.state).toBe('UNRESOLVED');
    expect(creatingResult.issueCodes).toContain('CREATE_STILL_CREATING');

    const unknownRun = baseEntry({ projectId: 'p1', state: 'OWNED', runIds: [] });
    const runEngine = new Stage6CleanupEngine(
      memoryLedger([unknownRun]),
      transport({
        getProject: vi.fn().mockResolvedValue({
          status: 200,
          project: { id: 'p1', name: unknownRun.exactName, state: 'READY', createdAt: unknownRun.preparedAt },
        }),
        getActiveRun: vi.fn().mockResolvedValue({ id: 'stranger', state: 'RUNNING' }),
        stopRun: vi.fn(),
        deleteProject: vi.fn(),
      }),
      clockAt(Date.parse(unknownRun.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    const runResult = await runEngine.cleanupOne(unknownRun);
    expect(runResult.state).toBe('UNRESOLVED');
    expect(runResult.issueCodes).toContain('UNKNOWN_ACTIVE_RUN');

    const held = baseEntry({ projectId: 'p1', state: 'HELD' });
    const heldEngine = new Stage6CleanupEngine(
      memoryLedger([held]),
      transport({ deleteProject: vi.fn() }),
      clockAt(Date.parse(held.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await heldEngine.cleanupOne(held)).state).toBe('HELD');
  });

  it('continues the second entry after the first cleanup throws', async () => {
    const first = baseEntry({ entryId: 'entry-1', projectId: 'p1', state: 'OWNED' });
    const second = baseEntry({ entryId: 'entry-2', projectId: 'p2', testId: 'case-2', state: 'OWNED' });
    const saved = [first, second];
    const engine = new Stage6CleanupEngine(
      memoryLedger(saved),
      transport({
        verifyOwner: vi.fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValue(undefined),
        getProject: vi.fn().mockResolvedValue({ status: 404 }),
        deleteProject: vi.fn(),
      }),
      clockAt(Date.parse(first.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    const report = await engine.sweep();
    expect(report.entries[0]?.state).toBe('UNRESOLVED');
    expect(report.entries[1]?.state).toBe('API_CLEANED');
    expect(report.entries[1]?.state).not.toBe('VERIFIED');
  });

  it('stops a recorded run once and waits until it is inactive before DELETE', async () => {
    const owned = baseEntry({ projectId: 'p1', state: 'OWNED', runIds: ['run-1'] });
    const ready = {
      status: 200 as const,
      project: { id: 'p1', name: owned.exactName, state: 'READY' as const, createdAt: owned.preparedAt },
    };
    const getActiveRun = vi.fn()
      .mockResolvedValueOnce({ id: 'run-1', state: 'RUNNING' })
      .mockResolvedValueOnce({ id: 'run-1', state: 'STOPPING' })
      .mockResolvedValueOnce(null);
    const stopRun = vi.fn().mockResolvedValue(undefined);
    const deleteProject = vi.fn().mockResolvedValue({ status: 204 });
    const getProject = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({ status: 404 });
    const engine = new Stage6CleanupEngine(
      memoryLedger([owned]),
      transport({ getProject, getActiveRun, stopRun, deleteProject }),
      clockAt(Date.parse(owned.preparedAt)),
      DEFAULT_CLEANUP_POLICY,
    );
    expect((await engine.cleanupOne(owned)).state).toBe('API_CLEANED');
    expect(stopRun).toHaveBeenCalledTimes(1);
    expect(stopRun).toHaveBeenCalledWith('alice', 'p1', 'run-1');
    expect(getActiveRun).toHaveBeenCalledTimes(3);
    expect(deleteProject).toHaveBeenCalledTimes(1);
    expect(getActiveRun.mock.invocationCallOrder[2]).toBeLessThan(deleteProject.mock.invocationCallOrder[0]);
  });
});
