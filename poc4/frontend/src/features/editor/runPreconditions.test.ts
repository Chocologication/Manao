import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRevision } from '../../contracts/file';
import {
  resolveRunPreconditions,
  runPreconditionDescription,
  terminalPreconditionDescription,
} from './runPreconditions';

const REVISION = 'mock-rev-0001' as WorkspaceRevision;

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
      }),
    ).toEqual({ canRequestRun: false, reason: 'DIRTY_FILES' });
    expect(
      resolveRunPreconditions({
        dirtyCount: 2,
        writePending: false,
        workspaceRevision: REVISION,
      }),
    ).toEqual({ canRequestRun: false, reason: 'DIRTY_FILES' });
  });

  it('returns WRITE_PENDING when a write is in flight and files are clean', () => {
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: true,
        workspaceRevision: REVISION,
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
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: undefined,
      }),
    ).toEqual({ canRequestRun: false, reason: 'REVISION_UNAVAILABLE' });
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: '' as WorkspaceRevision,
      }),
    ).toEqual({ canRequestRun: false, reason: 'REVISION_UNAVAILABLE' });
  });

  it('returns STAGE_4_UNAVAILABLE when clean and a revision is ready', () => {
    expect(
      resolveRunPreconditions({
        dirtyCount: 0,
        writePending: false,
        workspaceRevision: REVISION,
      }),
    ).toEqual({ canRequestRun: false, reason: 'STAGE_4_UNAVAILABLE' });
  });

  it('never allows a Run request and never issues /runs HTTP', () => {
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
    ];
    expect(cases.every((item) => item.canRequestRun === false)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runsFetchCount(fetchSpy)).toBe(0);
  });
});

describe('run and terminal descriptions', () => {
  it('keeps the exact reason code visible in accessible copy', () => {
    expect(runPreconditionDescription('DIRTY_FILES')).toMatch(/DIRTY_FILES/);
    expect(runPreconditionDescription('WRITE_PENDING')).toMatch(/WRITE_PENDING/);
    expect(runPreconditionDescription('REVISION_UNAVAILABLE')).toMatch(/REVISION_UNAVAILABLE/);
    expect(runPreconditionDescription('STAGE_4_UNAVAILABLE')).toMatch(/STAGE_4_UNAVAILABLE/);
    expect(terminalPreconditionDescription('DIRTY_FILES')).toMatch(/DIRTY_FILES/);
    expect(terminalPreconditionDescription('STAGE_4_UNAVAILABLE')).toMatch(/STAGE_4_UNAVAILABLE/);
  });
});

describe('runPreconditions module boundary', () => {
  it('does not request /runs or name physical identifiers', () => {
    const source = readFileSync('src/features/editor/runPreconditions.ts', 'utf8');
    expect(source).not.toMatch(/\/runs/);
    expect(source).not.toMatch(/pvcName|podName|jobName|namespace|serviceAccount/);
    expect(source).not.toMatch(/\/api\/v1\/session\/write-scenario/);
  });
});
