import { describe, expect, it } from 'vitest';
import type { LogChunk, LogWindowMeta } from '../../contracts/log';
import { parseRunId } from '../../contracts/run';
import {
  EMPTY_LOG_WINDOW,
  RunLogStore,
  runLogStoreKey,
  type NotificationScheduler,
} from './RunLogStore';

const PERSISTED_AT = '2026-08-24T10:00:02.000Z';
const ALICE = 'prj-alice';
const BOB = 'prj-bob';
const RUN = parseRunId('run-shared');

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function chunk(seq: number, text: string): LogChunk {
  return { seq, text, byteLength: utf8Bytes(text), persistedAt: PERSISTED_AT };
}

function windowFromChunks(
  chunks: readonly LogChunk[],
  extra: Partial<LogWindowMeta> = {},
): LogWindowMeta {
  const retainedBytes = chunks.reduce((sum, item) => sum + item.byteLength, 0);
  return {
    firstAvailableSeq: chunks[0]?.seq ?? null,
    lastAvailableSeq: chunks[chunks.length - 1]?.seq ?? null,
    retainedBytes,
    truncated: false,
    evictedBytes: 0,
    ...extra,
  };
}

function manualScheduler(): { schedule: NotificationScheduler; flush: () => void; pending: () => boolean } {
  let pending: (() => void) | null = null;
  return {
    schedule(notify) {
      pending = notify;
      return () => {
        if (pending === notify) {
          pending = null;
        }
      };
    },
    flush() {
      const notify = pending;
      pending = null;
      notify?.();
    },
    pending: () => pending !== null,
  };
}

describe('runLogStoreKey', () => {
  it('includes projectId and runId so Alice and Bob cannot collide', () => {
    expect(runLogStoreKey(ALICE, RUN)).not.toEqual(runLogStoreKey(BOB, RUN));
    expect(runLogStoreKey(ALICE, RUN)).not.toEqual(runLogStoreKey(ALICE, parseRunId('run-other')));
    expect(runLogStoreKey(ALICE, RUN)).toContain(ALICE);
    expect(runLogStoreKey(ALICE, RUN)).toContain(RUN);
  });
});

describe('RunLogStore', () => {
  it('scopes snapshots to project and run', () => {
    const scheduler = manualScheduler();
    const alice = new RunLogStore({ projectId: ALICE, runId: RUN, schedule: scheduler.schedule });
    const bob = new RunLogStore({ projectId: BOB, runId: RUN, schedule: scheduler.schedule });
    const item = chunk(1, 'alice-only');
    alice.applyAppend(item, windowFromChunks([item]));
    expect(alice.getSnapshot().projectId).toBe(ALICE);
    expect(alice.getSnapshot().runId).toBe(RUN);
    expect(alice.getSnapshot().chunks).toEqual([item]);
    expect(bob.getSnapshot().chunks).toEqual([]);
    expect(bob.getSnapshot().projectId).toBe(BOB);
  });

  it('keeps immutable chunk arrays and does not concatenate full text per append', () => {
    const first = chunk(1, 'hello ');
    const second = chunk(2, '你好');
    const store = new RunLogStore({
      projectId: ALICE,
      runId: RUN,
      schedule: manualScheduler().schedule,
    });
    store.applyAppend(first, windowFromChunks([first]));
    const before = store.getSnapshot();
    store.applyAppend(second, windowFromChunks([first, second]));
    const after = store.getSnapshot();
    expect(before.chunks).toEqual([first]);
    expect(after.chunks).toEqual([first, second]);
    expect(after.chunks).not.toBe(before.chunks);
    expect(after.chunks[0]).toBe(before.chunks[0]);
    expect(after).not.toHaveProperty('text');
    expect(typeof after.chunks.map((item) => item.text).join('')).toBe('string');
    expect(after.lastAppliedSeq).toBe(2);
    expect(after.window).toEqual(windowFromChunks([first, second]));
  });

  it('applies authoritative window metadata and evicts by firstAvailableSeq', () => {
    const store = new RunLogStore({
      projectId: ALICE,
      runId: RUN,
      schedule: manualScheduler().schedule,
    });
    const retained = [chunk(1, 'a'), chunk(2, 'bb'), chunk(3, 'ccc')];
    store.applyReplay(retained, windowFromChunks(retained));
    const truncated = {
      firstAvailableSeq: 3,
      lastAvailableSeq: 3,
      retainedBytes: retained[2]!.byteLength,
      truncated: true,
      evictedBytes: 3,
    };
    store.applyWindow(truncated);
    const snapshot = store.getSnapshot();
    expect(snapshot.chunks).toEqual([retained[2]]);
    expect(snapshot.window).toEqual(truncated);
    expect(snapshot.lastAppliedSeq).toBe(3);
  });

  it('ignores duplicate seq and keeps last applied seq', () => {
    const store = new RunLogStore({
      projectId: ALICE,
      runId: RUN,
      schedule: manualScheduler().schedule,
    });
    const first = chunk(1, 'a');
    const duplicate = chunk(1, 'a-dup');
    store.applyAppend(first, windowFromChunks([first]));
    store.applyAppend(duplicate, windowFromChunks([duplicate]));
    expect(store.getSnapshot().chunks).toEqual([first]);
    expect(store.getSnapshot().lastAppliedSeq).toBe(1);
  });

  it('does not concatenate copies when overlapping seqs are replayed against a retained lastSeq', () => {
    const store = new RunLogStore({
      projectId: ALICE,
      runId: RUN,
      schedule: manualScheduler().schedule,
    });
    const first = chunk(1, 'alpha');
    const second = chunk(2, 'beta');
    const third = chunk(3, 'gamma');
    store.applyReplay([first, second], windowFromChunks([first, second]));
    expect(store.getSnapshot().lastAppliedSeq).toBe(2);
    store.applyReplay([first, second, third], windowFromChunks([first, second, third]));
    expect(store.getSnapshot().chunks).toEqual([first, second, third]);
    expect(store.getSnapshot().chunks.filter((item) => item.seq === 1)).toHaveLength(1);
    expect(store.getSnapshot().chunks.filter((item) => item.seq === 2)).toHaveLength(1);
    expect(store.getSnapshot().lastAppliedSeq).toBe(3);
  });

  it('batches subscriber notifications through the injectable scheduler', () => {
    const scheduler = manualScheduler();
    const store = new RunLogStore({ projectId: ALICE, runId: RUN, schedule: scheduler.schedule });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const first = chunk(1, 'a');
    const second = chunk(2, 'b');
    store.applyAppend(first, windowFromChunks([first]));
    store.applyAppend(second, windowFromChunks([first, second]));
    store.setConnection('live');
    expect(notifications).toBe(0);
    expect(store.getSnapshot().chunks).toHaveLength(2);
    expect(store.getSnapshot().connection).toBe('live');
    scheduler.flush();
    expect(notifications).toBe(1);
    store.setError('FORBIDDEN');
    store.markComplete();
    scheduler.flush();
    expect(notifications).toBe(2);
    expect(store.getSnapshot()).toMatchObject({
      connection: 'complete',
      error: null,
      lastAppliedSeq: 2,
    });
  });

  it('starts idle with an empty window and can set pendingOutput without changing chunks', () => {
    const store = new RunLogStore({
      projectId: ALICE,
      runId: RUN,
      schedule: manualScheduler().schedule,
    });
    expect(store.getSnapshot()).toEqual({
      projectId: ALICE,
      runId: RUN,
      chunks: [],
      lastAppliedSeq: null,
      window: EMPTY_LOG_WINDOW,
      connection: 'idle',
      pendingOutput: false,
      error: null,
    });
    store.setPendingOutput(true);
    expect(store.getSnapshot().pendingOutput).toBe(true);
    expect(store.getSnapshot().chunks).toEqual([]);
  });

  it('does not notify after dispose', () => {
    const scheduler = manualScheduler();
    const store = new RunLogStore({ projectId: ALICE, runId: RUN, schedule: scheduler.schedule });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.setConnection('ticketing');
    store.dispose();
    store.dispose();
    scheduler.flush();
    store.setConnection('live');
    expect(notifications).toBe(0);
    expect(scheduler.pending()).toBe(false);
  });
});
