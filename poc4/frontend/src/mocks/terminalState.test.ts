import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunState } from '../contracts/run';
import { parseTerminalAuditListResponse } from '../contracts/terminal';
import {
  getActiveRun,
  installVirtualRunClock,
  setMockRunPersistNotifyObserver,
  startRun,
  subscribeMockRunBeforeTransition,
  transitionRun,
} from './runState';
import {
  ALICE_SEED_PROJECT_ID,
  BOB_SEED_PROJECT_ID,
  createOwnedProject,
  resetMockState,
} from './state';
import {
  classifyTerminalTicketForHandshake,
  consumeTerminalTicket,
  consumeTerminalTicketByTicket,
  endTerminalSession,
  getTerminalScenario,
  getTerminalReservationBackingStoreDiagnostics,
  getLiveTerminalSession,
  getTerminalReservationCount,
  getUnusedTerminalReservationCount,
  issueTerminalReservation,
  isTerminalScenario,
  listTerminalAudits,
  MOCK_TERMINAL_PERSISTENCE_KEY,
  seedTerminalAuditFixtures,
  setTerminalScenario,
  subscribeTerminalStateEvents,
} from './terminalState';

const ALICE_ID = 'usr-alice';
const BOB_ID = 'usr-bob';
const NOW = Date.parse('2026-08-25T10:00:00.000Z');
const SEED_REVISION = 'mock-rev-0001';

function startInState(state: RunState) {
  const started = startRun(ALICE_SEED_PROJECT_ID, {
    expectedWorkspaceRevision: SEED_REVISION,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.code);
  if (state !== 'STARTING') {
    const running = transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, {
      state: 'RUNNING',
    });
    expect(running.ok).toBe(true);
  }
  if (state !== 'STARTING' && state !== 'RUNNING') {
    const next = transitionRun(ALICE_SEED_PROJECT_ID, started.value.run.id, { state });
    expect(next.ok).toBe(true);
  }
  return started.value.run.id;
}

function issueOk(runId: string, cols = 80, rows = 24) {
  const result = issueTerminalReservation(
    ALICE_ID,
    ALICE_SEED_PROJECT_ID,
    runId,
    { cols, rows },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetMockState();
  installVirtualRunClock(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('terminal reservation authority', () => {
  it('issues only for the owner of a READY project and its current RUNNING run', () => {
    const runId = startInState('RUNNING');

    const result = issueTerminalReservation(
      ALICE_ID,
      ALICE_SEED_PROJECT_ID,
      runId,
      { cols: 80, rows: 24 },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        sessionId: 'mock-terminal-session-1',
        ticket: 'mock-terminal-ticket-1',
        expiresAt: '2026-08-25T10:00:30.000Z',
      },
    });
  });

  it('reuses the strict terminal request parser for dimensions and exact keys', () => {
    const runId = startInState('RUNNING');

    expect(
      issueTerminalReservation(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        cols: 1,
        rows: 24,
      }),
    ).toEqual({ ok: false, code: 'VALIDATION_ERROR' });
    expect(
      issueTerminalReservation(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        cols: 80,
        rows: 24,
        command: 'whoami',
      }),
    ).toEqual({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it.each([
    ['STARTING run', ALICE_ID, ALICE_SEED_PROJECT_ID, 'STARTING'],
    ['STOPPING run', ALICE_ID, ALICE_SEED_PROJECT_ID, 'STOPPING'],
    ['RECOVERING run', ALICE_ID, ALICE_SEED_PROJECT_ID, 'RECOVERING'],
    ['terminal run', ALICE_ID, ALICE_SEED_PROJECT_ID, 'SUCCEEDED'],
    ['other owner', BOB_ID, ALICE_SEED_PROJECT_ID, 'RUNNING'],
  ] as const)('rejects %s without leaking identifiers', (_label, userId, projectId, state) => {
    const runId = startInState(state);

    const result = issueTerminalReservation(userId, projectId, runId, {
      cols: 80,
      rows: 24,
    });

    expect(result).toEqual({ ok: false, code: 'TERMINAL_NOT_AVAILABLE' });
    expect(JSON.stringify(result)).not.toMatch(
      /prj-alice|usr-alice|usr-bob|pvc|pod|job|container|C:\\|D:\\|\/home\/|\/var\//i,
    );
  });

  it('rejects history, unknown run, unknown project and non-READY project authority', () => {
    const historyRunId = startInState('SUCCEEDED');
    const currentRunId = startInState('RUNNING');
    const creating = createOwnedProject(ALICE_ID, 'creating-terminal-project');
    expect(creating.status).toBe('created');
    if (creating.status !== 'created') throw new Error('project limit');

    for (const [projectId, runId] of [
      [ALICE_SEED_PROJECT_ID, historyRunId],
      [ALICE_SEED_PROJECT_ID, 'run-unknown'],
      ['prj-unknown', currentRunId],
      [creating.project.id, currentRunId],
      [BOB_SEED_PROJECT_ID, currentRunId],
    ]) {
      expect(
        issueTerminalReservation(ALICE_ID, projectId, runId, { cols: 80, rows: 24 }),
      ).toEqual({ ok: false, code: 'TERMINAL_NOT_AVAILABLE' });
    }
  });
});

describe('terminal ticket lifecycle', () => {
  it('releases expired, used and unavailable backing records after the replay grace', () => {
    const runId = startInState('RUNNING');
    const expired = issueOk(runId);
    vi.advanceTimersByTime(30_000);
    expect(classifyTerminalTicketForHandshake(expired.ticket)).toEqual({
      ok: false,
      code: 'TICKET_EXPIRED',
    });

    const used = issueOk(runId);
    expect(consumeTerminalTicketByTicket(used.ticket).ok).toBe(true);
    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: used.sessionId,
      reason: 'CLIENT_CLOSED',
      exitCode: null,
    }).ok).toBe(true);
    const unavailable = issueOk(runId);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 3, timers: 3 });

    vi.advanceTimersByTime(4_999);
    expect(classifyTerminalTicketForHandshake(expired.ticket)).toEqual({
      ok: false,
      code: 'TICKET_EXPIRED',
    });
    expect(classifyTerminalTicketForHandshake(used.ticket)).toEqual({
      ok: false,
      code: 'TICKET_ALREADY_USED',
    });
    expect(classifyTerminalTicketForHandshake(unavailable.ticket)).toEqual({
      ok: false,
      code: 'SESSION_NOT_AVAILABLE',
    });
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 3, timers: 3 });

    vi.advanceTimersByTime(1);
    expect(classifyTerminalTicketForHandshake(expired.ticket)).toEqual({
      ok: false,
      code: 'TICKET_NOT_AVAILABLE',
    });
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 2, timers: 2 });

    vi.advanceTimersByTime(29_999);
    expect(classifyTerminalTicketForHandshake(used.ticket)).toEqual({
      ok: false,
      code: 'TICKET_ALREADY_USED',
    });
    expect(classifyTerminalTicketForHandshake(unavailable.ticket)).toEqual({
      ok: false,
      code: 'SESSION_NOT_AVAILABLE',
    });
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 2, timers: 2 });

    vi.advanceTimersByTime(1);
    for (const ticket of [used.ticket, unavailable.ticket]) {
      expect(classifyTerminalTicketForHandshake(ticket)).toEqual({
        ok: false,
        code: 'TICKET_NOT_AVAILABLE',
      });
    }
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 0, timers: 0 });
  });

  it('reset clears backing records and timers without stale timer deletion after ID reuse', () => {
    const runId = startInState('RUNNING');
    const beforeReset = issueOk(runId);
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 1, timers: 1 });
    vi.advanceTimersByTime(10_000);

    resetMockState();
    installVirtualRunClock(Date.now());
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 0, timers: 0 });
    const nextRunId = startInState('RUNNING');
    const afterReset = issueOk(nextRunId);
    expect(afterReset.ticket).toBe(beforeReset.ticket);
    vi.advanceTimersByTime(25_000);

    expect(classifyTerminalTicketForHandshake(afterReset.ticket)).toEqual({ ok: true });
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 1, timers: 1 });
    resetMockState();
    expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({ records: 0, timers: 0 });
  });

  it('does not accumulate backing records across repeated issue windows', () => {
    const runId = startInState('RUNNING');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let index = 0; index < 20; index += 1) issueOk(runId);
      expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({
        records: 20,
        timers: 20,
      });
      vi.advanceTimersByTime(35_000);
      expect(getTerminalReservationBackingStoreDiagnostics()).toEqual({
        records: 0,
        timers: 0,
      });
    }
  });

  it('classifies authoritative handshake failures without exposing reservation identity', () => {
    const runId = startInState('RUNNING');
    expect(classifyTerminalTicketForHandshake('mock-terminal-ticket-missing')).toEqual({
      ok: false,
      code: 'TICKET_NOT_AVAILABLE',
    });

    const available = issueOk(runId);
    expect(classifyTerminalTicketForHandshake(available.ticket)).toEqual({ ok: true });

    const expired = issueOk(runId);
    vi.advanceTimersByTime(30_000);
    expect(classifyTerminalTicketForHandshake(expired.ticket)).toEqual({
      ok: false,
      code: 'TICKET_EXPIRED',
    });

    vi.setSystemTime(NOW);
    const live = issueOk(runId);
    const blocked = issueOk(runId);
    expect(consumeTerminalTicketByTicket(live.ticket).ok).toBe(true);
    expect(classifyTerminalTicketForHandshake(live.ticket)).toEqual({
      ok: false,
      code: 'TICKET_ALREADY_USED',
    });
    expect(classifyTerminalTicketForHandshake(blocked.ticket)).toEqual({
      ok: false,
      code: 'SESSION_ALREADY_ACTIVE',
    });
    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: live.sessionId,
      reason: 'CLIENT_CLOSED',
      exitCode: null,
    }).ok).toBe(true);

    const unavailable = issueOk(runId);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
    expect(classifyTerminalTicketForHandshake(unavailable.ticket)).toEqual({
      ok: false,
      code: 'SESSION_NOT_AVAILABLE',
    });
  });

  it('atomically resolves and consumes the authoritative reservation by raw ticket', () => {
    const runId = startInState('RUNNING');
    const reservation = issueOk(runId, 132, 43);

    expect(consumeTerminalTicketByTicket(reservation.ticket)).toMatchObject({
      ok: true,
      value: {
        userId: ALICE_ID,
        projectId: ALICE_SEED_PROJECT_ID,
        runId,
        sessionId: reservation.sessionId,
        cols: 132,
        rows: 43,
        state: 'live',
      },
    });
  });

  it('fails raw ticket consumption closed for missing, expired, used and lost authority', () => {
    const runId = startInState('RUNNING');
    expect(consumeTerminalTicketByTicket('mock-terminal-ticket-missing')).toEqual({
      ok: false,
      code: 'TERMINAL_TICKET_NOT_AVAILABLE',
    });

    const expired = issueOk(runId);
    vi.advanceTimersByTime(30_000);
    expect(consumeTerminalTicketByTicket(expired.ticket)).toEqual({
      ok: false,
      code: 'TERMINAL_TICKET_NOT_AVAILABLE',
    });

    vi.setSystemTime(NOW);
    const used = issueOk(runId);
    expect(consumeTerminalTicketByTicket(used.ticket).ok).toBe(true);
    expect(consumeTerminalTicketByTicket(used.ticket)).toEqual({
      ok: false,
      code: 'TERMINAL_TICKET_NOT_AVAILABLE',
    });
    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: used.sessionId,
      reason: 'CLIENT_CLOSED',
      exitCode: null,
    }).ok).toBe(true);

    const revoked = issueOk(runId);
    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);
    expect(consumeTerminalTicketByTicket(revoked.ticket)).toEqual({
      ok: false,
      code: 'TERMINAL_TICKET_NOT_AVAILABLE',
    });
  });

  it('keeps HTTP reservations inactive, bound to dimensions and independently unused', () => {
    const runId = startInState('RUNNING');
    const first = issueOk(runId, 132, 43);
    const second = issueOk(runId, 90, 30);

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.ticket).not.toBe(second.ticket);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(getUnusedTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(2);

    const consumed = consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: first.sessionId,
      ticket: first.ticket,
    });
    expect(consumed).toMatchObject({
      ok: true,
      value: { sessionId: first.sessionId, cols: 132, rows: 43, state: 'live' },
    });
    expect(getUnusedTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
  });

  it('expires at thirty seconds without a wall-clock sleep', () => {
    const runId = startInState('RUNNING');
    const reservation = issueOk(runId);
    vi.advanceTimersByTime(30_000);

    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: reservation.sessionId,
      ticket: reservation.ticket,
    })).toEqual({ ok: false, code: 'TERMINAL_TICKET_NOT_AVAILABLE' });
  });

  it('does not consume a ticket on wrong owner, project, run or session', () => {
    const runId = startInState('RUNNING');
    const reservation = issueOk(runId);
    const base = {
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: reservation.sessionId,
      ticket: reservation.ticket,
    };

    for (const mismatch of [
      { userId: BOB_ID },
      { projectId: BOB_SEED_PROJECT_ID },
      { runId: 'run-other' },
      { sessionId: 'mock-terminal-session-other' },
    ]) {
      expect(consumeTerminalTicket({ ...base, ...mismatch })).toEqual({
        ok: false,
        code: 'TERMINAL_TICKET_NOT_AVAILABLE',
      });
    }
    expect(consumeTerminalTicket(base).ok).toBe(true);
    expect(consumeTerminalTicket(base)).toEqual({
      ok: false,
      code: 'TERMINAL_TICKET_NOT_AVAILABLE',
    });
  });

  it('does not publish live state or consume the ticket when audit construction throws', () => {
    const runId = startInState('RUNNING');
    const reservation = issueOk(runId);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    try {
      expect(() => consumeTerminalTicket({
        userId: ALICE_ID,
        projectId: ALICE_SEED_PROJECT_ID,
        runId,
        sessionId: reservation.sessionId,
        ticket: reservation.ticket,
      })).toThrow(RangeError);
    } finally {
      nowSpy.mockRestore();
    }

    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: reservation.sessionId,
      ticket: reservation.ticket,
    }).ok).toBe(true);
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
  });

  it('clears reservations, live sessions and deterministic counters through resetMockState', () => {
    const runId = startInState('RUNNING');
    const beforeReset = issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: beforeReset.sessionId,
      ticket: beforeReset.ticket,
    }).ok).toBe(true);

    resetMockState();
    installVirtualRunClock(NOW);
    const nextRunId = startInState('RUNNING');
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: beforeReset.sessionId,
      ticket: beforeReset.ticket,
    })).toEqual({ ok: false, code: 'TERMINAL_TICKET_NOT_AVAILABLE' });
    expect(issueOk(nextRunId)).toMatchObject({
      sessionId: 'mock-terminal-session-1',
      ticket: 'mock-terminal-ticket-1',
    });
  });
});

describe('single live terminal session', () => {
  it('atomically rejects a second valid unused ticket and new HTTP reservations', () => {
    const runId = startInState('RUNNING');
    const first = issueOk(runId);
    const second = issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: first.sessionId,
      ticket: first.ticket,
    }).ok).toBe(true);

    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: second.sessionId,
      ticket: second.ticket,
    })).toEqual({ ok: false, code: 'TERMINAL_SESSION_ALREADY_ACTIVE' });
    expect(getUnusedTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(1);
    expect(issueTerminalReservation(
      ALICE_ID,
      ALICE_SEED_PROJECT_ID,
      runId,
      { cols: 80, rows: 24 },
    )).toEqual({ ok: false, code: 'TERMINAL_SESSION_ALREADY_ACTIVE' });
  });

  it.each([
    ['CLIENT_CLOSED', 'closed'],
    ['CONNECTION_LOST', 'interrupted'],
  ] as const)('allows a new ID only after %s ends the live session', (reason, state) => {
    const runId = startInState('RUNNING');
    const first = issueOk(runId);
    const stale = issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: first.sessionId,
      ticket: first.ticket,
    }).ok).toBe(true);

    expect(endTerminalSession({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: first.sessionId,
      reason,
      exitCode: null,
    })).toMatchObject({ ok: true, value: { state, reason } });
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
    expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('RUNNING');
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: stale.sessionId,
      ticket: stale.ticket,
    })).toEqual({ ok: false, code: 'TERMINAL_TICKET_NOT_AVAILABLE' });

    const next = issueOk(runId);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(next.ticket).not.toBe(first.ticket);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: next.sessionId,
      ticket: next.ticket,
    }).ok).toBe(true);
  });
});

describe('Run transition ordering', () => {
  it('invalidates reservations and closes live sessions before settling Run state', () => {
    const runId = startInState('RUNNING');
    const live = issueOk(runId);
    const unused = issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: live.sessionId,
      ticket: live.ticket,
    }).ok).toBe(true);
    const order: string[] = [];
    subscribeTerminalStateEvents((event) => {
      if (event.type === 'reservation.invalidated') {
        order.push(`reservation:${event.sessionId}`);
      } else {
        order.push(`session:${event.session.sessionId}:${event.session.reason}`);
      }
    });
    setMockRunPersistNotifyObserver((phase, event) => {
      if (event.type === 'run.state' && event.run.id === runId) {
        order.push(`run:${phase}:${event.run.state}`);
      }
    });

    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);

    expect(order).toEqual([
      `reservation:${unused.sessionId}`,
      `session:${live.sessionId}:RUN_LEFT_RUNNING`,
      'run:persist:STOPPING',
      'run:notify:STOPPING',
    ]);
    expect(getUnusedTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
    expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
    expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
  });

  it('commits terminal cleanup and Run state despite a throwing external observer', () => {
    const runId = startInState('RUNNING');
    const live = issueOk(runId);
    issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: live.sessionId,
      ticket: live.ticket,
    }).ok).toBe(true);
    const snapshots: Array<{ reservations: number; live: boolean }> = [];
    const unsubscribeThrowing = subscribeTerminalStateEvents(() => {
      throw new Error('terminal observer failure');
    });
    const unsubscribeInspecting = subscribeTerminalStateEvents(() => {
      snapshots.push({
        reservations: getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId),
        live: getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId) !== null,
      });
    });
    try {
      let result: ReturnType<typeof transitionRun> | undefined;
      expect(() => {
        result = transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' });
      }).not.toThrow();

      expect(result?.ok).toBe(true);
      expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('STOPPING');
      expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
      expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots.every((snapshot) => snapshot.reservations === 0 && !snapshot.live)).toBe(true);
    } finally {
      unsubscribeThrowing();
      unsubscribeInspecting();
    }
  });

  it('rejects a reservation created reentrantly from a terminal finalization observer', () => {
    const runId = startInState('RUNNING');
    const live = issueOk(runId);
    issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: live.sessionId,
      ticket: live.ticket,
    }).ok).toBe(true);
    let attempted = false;
    let reentrant: ReturnType<typeof issueTerminalReservation> | null = null;
    const unsubscribe = subscribeTerminalStateEvents(() => {
      if (attempted) return;
      attempted = true;
      reentrant = issueTerminalReservation(
        ALICE_ID,
        ALICE_SEED_PROJECT_ID,
        runId,
        { cols: 80, rows: 24 },
      );
    });
    try {
      expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'STOPPING' }).ok).toBe(true);

      expect(reentrant).toEqual({ ok: false, code: 'TERMINAL_NOT_AVAILABLE' });
      expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('fails create and consume closed inside a public Run before-transition observer', () => {
    const runId = startInState('RUNNING');
    const created: Array<ReturnType<typeof issueTerminalReservation>> = [];
    const consumed: Array<ReturnType<typeof consumeTerminalTicket>> = [];
    const unsubscribe = subscribeMockRunBeforeTransition(() => {
      const reservation = issueTerminalReservation(
        ALICE_ID,
        ALICE_SEED_PROJECT_ID,
        runId,
        { cols: 80, rows: 24 },
      );
      created.push(reservation);
      if (reservation.ok) {
        consumed.push(consumeTerminalTicket({
          userId: ALICE_ID,
          projectId: ALICE_SEED_PROJECT_ID,
          runId,
          sessionId: reservation.value.sessionId,
          ticket: reservation.value.ticket,
        }));
      }
    });
    try {
      expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'RECOVERING' }).ok).toBe(true);

      expect(created).toEqual([{ ok: false, code: 'TERMINAL_NOT_AVAILABLE' }]);
      expect(consumed).toEqual([]);
      expect(getActiveRun(ALICE_SEED_PROJECT_ID)?.state).toBe('RECOVERING');
      expect(getTerminalReservationCount(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBe(0);
      expect(getLiveTerminalSession(ALICE_ID, ALICE_SEED_PROJECT_ID, runId)).toBeNull();
      expect(listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId).items).toEqual([]);
    } finally {
      unsubscribe();
    }

    expect(transitionRun(ALICE_SEED_PROJECT_ID, runId, { state: 'RUNNING' }).ok).toBe(true);
    const afterTransition = issueOk(runId);
    expect(consumeTerminalTicket({
      userId: ALICE_ID,
      projectId: ALICE_SEED_PROJECT_ID,
      runId,
      sessionId: afterTransition.sessionId,
      ticket: afterTransition.ticket,
    }).ok).toBe(true);
  });
});

describe('structured terminal audits', () => {
  it('creates RUNNING on handshake and settles shell success, failure and disconnect', () => {
    const runId = startInState('RUNNING');
    const endings = [
      ['SHELL_EXITED', 0, 'SUCCEEDED'],
      ['SHELL_EXITED', 17, 'FAILED'],
      ['CONNECTION_LOST', null, 'INTERRUPTED'],
    ] as const;

    for (const [reason, exitCode, state] of endings) {
      const reservation = issueOk(runId);
      expect(consumeTerminalTicket({
        userId: ALICE_ID,
        projectId: ALICE_SEED_PROJECT_ID,
        runId,
        sessionId: reservation.sessionId,
        ticket: reservation.ticket,
      }).ok).toBe(true);
      const running = listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        sessionId: reservation.sessionId,
      });
      expect(parseTerminalAuditListResponse(running).items).toMatchObject([
        { sessionId: reservation.sessionId, command: 'mvn test', state: 'RUNNING' },
      ]);

      vi.advanceTimersByTime(1_000);
      expect(endTerminalSession({
        userId: ALICE_ID,
        projectId: ALICE_SEED_PROJECT_ID,
        runId,
        sessionId: reservation.sessionId,
        reason,
        exitCode,
      }).ok).toBe(true);
      const settled = listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        sessionId: reservation.sessionId,
      });
      expect(parseTerminalAuditListResponse(settled).items).toMatchObject([
        { sessionId: reservation.sessionId, state, exitCode },
      ]);
    }
  });

  it('uses backend fixtures with owner/session isolation, newest-first pagination and retention', () => {
    const runId = 'run-audit-fixture';
    seedTerminalAuditFixtures(ALICE_ID, ALICE_SEED_PROJECT_ID, runId);
    seedTerminalAuditFixtures(BOB_ID, ALICE_SEED_PROJECT_ID, runId);

    const alice = parseTerminalAuditListResponse(
      listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId),
    );
    expect(alice.items.map((entry) => entry.state).sort()).toEqual([
      'FAILED',
      'INTERRUPTED',
      'RUNNING',
      'SUCCEEDED',
    ]);
    expect(alice.items.every((entry) => entry.id.startsWith('mock-terminal-audit-'))).toBe(true);
    expect(alice.items.map((entry) => Date.parse(entry.startedAt))).toEqual(
      [...alice.items].map((entry) => Date.parse(entry.startedAt)).sort((a, b) => b - a),
    );
    expect(alice.items.some((entry) => entry.command === 'ensoai-stage5-terminal-stress')).toBe(true);
    expect(JSON.stringify(alice)).not.toMatch(/rawOutput|raw-output|terminal bytes|\"output\"/i);

    const firstPage = parseTerminalAuditListResponse(
      listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, { limit: 2 }),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = parseTerminalAuditListResponse(
      listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        limit: 2,
        cursor: firstPage.nextCursor,
      }),
    );
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((entry) => entry.id)).size).toBe(4);

    const sessionOnly = parseTerminalAuditListResponse(
      listTerminalAudits(ALICE_ID, ALICE_SEED_PROJECT_ID, runId, {
        sessionId: alice.items[0]?.sessionId,
      }),
    );
    expect(sessionOnly.items).toHaveLength(1);
    expect(sessionOnly.items[0]?.sessionId).toBe(alice.items[0]?.sessionId);
    expect(listTerminalAudits('usr-other', ALICE_SEED_PROJECT_ID, runId).items).toEqual([]);
    expect(listTerminalAudits(BOB_ID, ALICE_SEED_PROJECT_ID, runId).items).toHaveLength(4);
  });
});

describe('terminal scenario state', () => {
  it('accepts every Stage 5 fixture and persists only compact mock scenario state', () => {
    for (const scenario of [
      'normal',
      'ticket-expired',
      'already-active',
      'server-pause',
      'disconnect',
      'shell-exit',
      'webgl-fallback',
      'audit',
      'stress',
    ] as const) {
      expect(isTerminalScenario(scenario)).toBe(true);
      setTerminalScenario(scenario);
      expect(getTerminalScenario()).toBe(scenario);
      expect(sessionStorage.getItem(MOCK_TERMINAL_PERSISTENCE_KEY)).toBe(
        JSON.stringify({ version: 1, scenario }),
      );
    }
    expect(isTerminalScenario('production')).toBe(false);
  });

  it('resetMockState restores normal and removes the terminal scenario persistence key', () => {
    setTerminalScenario('stress');
    expect(sessionStorage.getItem(MOCK_TERMINAL_PERSISTENCE_KEY)).not.toBeNull();

    resetMockState();

    expect(getTerminalScenario()).toBe('normal');
    expect(sessionStorage.getItem(MOCK_TERMINAL_PERSISTENCE_KEY)).toBeNull();
  });
});
