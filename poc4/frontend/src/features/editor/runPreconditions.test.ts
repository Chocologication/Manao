import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRevision } from '../../contracts/file';
import {
  resolveRunPreconditions,
  runPreconditionDescription,
} from './runPreconditions';

const REVISION = 'mock-rev-0001' as WorkspaceRevision;

const ALLOWED = {
  dirtyCount: 0,
  writePending: false,
  workspaceRevision: REVISION,
  authorityLoaded: true,
  hasActiveLockingRun: false,
  startPending: false,
  reloadPhase: 'EDITABLE' as const,
};

function requestUrl(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return '';
}

function runsFetchCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => /\/runs(?:\?|\/|$)/.test(requestUrl(call[0]))).length;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRunPreconditions', () => {
  it('returns DIRTY_FILES first when dirty files exist', () => {
    expect(
      resolveRunPreconditions({
        dirtyCount: 1,
        writePending: true,
        workspaceRevision: undefined,
        authorityLoaded: false,
        hasActiveLockingRun: true,
        startPending: true,
        reloadPhase: 'RELOAD_FAILED',
      }),
    ).toEqual({ canRequestRun: false, reason: 'DIRTY_FILES' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        dirtyCount: 2,
      }),
    ).toEqual({ canRequestRun: false, reason: 'DIRTY_FILES' });
  });

  it('returns WRITE_PENDING when a write is in flight and files are clean', () => {
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        writePending: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'WRITE_PENDING' });
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: true,
        workspaceRevision: undefined,
      }),
    ).toEqual({ canRequestRun: false, reason: 'WRITE_PENDING' });
  });

  it('returns REVISION_UNAVAILABLE when the workspace revision is missing', () => {
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        workspaceRevision: undefined,
      }),
    ).toEqual({ canRequestRun: false, reason: 'REVISION_UNAVAILABLE' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        workspaceRevision: '' as WorkspaceRevision,
      }),
    ).toEqual({ canRequestRun: false, reason: 'REVISION_UNAVAILABLE' });
  });

  it('keeps STAGE_4_UNAVAILABLE when authority fields are omitted', () => {
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: REVISION,
      }),
    ).toEqual({ canRequestRun: false, reason: 'STAGE_4_UNAVAILABLE' });
  });

  it('returns authority, reload, and active reasons after dirty/write/revision checks', () => {
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        authorityLoaded: false,
        reloadPhase: 'LOADING_AUTHORITY',
        hasActiveLockingRun: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'AUTHORITY_LOADING' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        reloadPhase: 'RELOADING_WORKSPACE',
        hasActiveLockingRun: true,
        startPending: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'RELOADING_WORKSPACE' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        reloadPhase: 'RELOAD_FAILED',
        startPending: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'RELOAD_FAILED' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        startPending: true,
        hasActiveLockingRun: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'START_PENDING' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        hasActiveLockingRun: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'RUN_ACTIVE' });
    expect(
      resolveRunPreconditions({
        ...ALLOWED,
        hasActiveLockingRun: true,
        reloadPhase: 'LOADING_AUTHORITY',
      }),
    ).toEqual({ canRequestRun: false, reason: 'RUN_ACTIVE' });
  });

  it('fails closed when authority fields are only partially provided', () => {
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: REVISION,
        authorityLoaded: true,
      }),
    ).toEqual({ canRequestRun: false, reason: 'AUTHORITY_LOADING' });
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: REVISION,
        authorityLoaded: true,
        hasActiveLockingRun: false,
        startPending: false,
      }),
    ).toEqual({ canRequestRun: false, reason: 'AUTHORITY_LOADING' });
  });

  it('allows a Run request only when authority is loaded, editable, and idle', () => {
    expect(resolveRunPreconditions(ALLOWED)).toEqual({ canRequestRun: true, reason: null });
  });

  it('does not issue /runs HTTP while resolving preconditions', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cases = [
      resolveRunPreconditions({
        dirtyCount: 1,
        writePending: true,
        workspaceRevision: undefined,
      }),
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: true,
        workspaceRevision: REVISION,
      }),
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: undefined,
      }),
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: REVISION,
      }),
      resolveRunPreconditions(ALLOWED),
    ];
    expect(cases.map((item) => item.canRequestRun)).toEqual([false, false, false, false, true]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runsFetchCount(fetchSpy)).toBe(0);
  });
});

describe('run descriptions', () => {
  it('keeps the exact reason code visible in accessible copy', () => {
    expect(runPreconditionDescription('DIRTY_FILES')).toMatch(/DIRTY_FILES/);
    expect(runPreconditionDescription('WRITE_PENDING')).toMatch(/WRITE_PENDING/);
    expect(runPreconditionDescription('REVISION_UNAVAILABLE')).toMatch(/REVISION_UNAVAILABLE/);
    expect(runPreconditionDescription('AUTHORITY_LOADING')).toMatch(/AUTHORITY_LOADING/);
    expect(runPreconditionDescription('RUN_ACTIVE')).toMatch(/RUN_ACTIVE/);
    expect(runPreconditionDescription('START_PENDING')).toMatch(/START_PENDING/);
    expect(runPreconditionDescription('RELOADING_WORKSPACE')).toMatch(/RELOADING_WORKSPACE/);
    expect(runPreconditionDescription('RELOAD_FAILED')).toMatch(/RELOAD_FAILED/);
    expect(runPreconditionDescription('STAGE_4_UNAVAILABLE')).toMatch(/STAGE_4_UNAVAILABLE/);
  });
});

describe('runPreconditions module boundary', () => {
  it('does not request /runs or name physical identifiers', () => {
    const source = readFileSync('src/features/editor/runPreconditions.ts', 'utf8');
    expect(source).not.toMatch(/\/api\/v1\/.*runs/);
    expect(source).not.toMatch(/pvcName|podName|jobName|namespace|serviceAccount/);
    expect(source).not.toMatch(/\/api\/v1\/session\/write-scenario/);
    expect(source).not.toMatch(/terminal/i);
  });
});
