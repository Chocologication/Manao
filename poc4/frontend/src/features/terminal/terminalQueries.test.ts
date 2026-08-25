import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { login } from '../../api/authApi';
import { ApiRequestError } from '../../api/ApiRequestError';
import { AppProviders } from '../../app/AppProviders';
import { authSession, queryClient } from '../../app/appRuntime';
import { parseRunId } from '../../contracts/run';
import {
  parseTerminalAuditId,
  parseTerminalSessionId,
  type TerminalAuditEntry,
} from '../../contracts/terminal';
import { server } from '../../mocks/node';
import { ALICE_SEED_PROJECT_ID } from '../../mocks/state';
import { resetAppRuntime } from '../../test/renderApp';
import type { JobTerminalPhase } from './JobTerminalController';
import {
  invalidateTerminalAudits,
  retryTerminalAuditQuery,
  TERMINAL_AUDIT_POLL_MS,
  TERMINAL_AUDIT_QUERY_MAX_RETRIES,
  terminalAuditKeys,
  terminalAuditRefetchInterval,
  useTerminalAuditQuery,
} from './terminalQueries';

const RUN_ID = parseRunId('run-channel-9');

function audit(
  id: string,
  command: string,
  startedAt: string,
  state: TerminalAuditEntry['state'] = 'SUCCEEDED',
): TerminalAuditEntry {
  return {
    id: parseTerminalAuditId(id),
    sessionId: parseTerminalSessionId('session-audit'),
    command,
    state,
    startedAt,
    finishedAt: state === 'RUNNING' ? null : new Date(Date.parse(startedAt) + 1000).toISOString(),
    exitCode: state === 'RUNNING' ? null : 0,
  };
}

async function authenticateAsAlice(): Promise<void> {
  const response = await login({ username: 'alice', password: 'demo-pass' });
  authSession.authenticate(response);
}

beforeEach(() => {
  resetAppRuntime();
});

afterEach(async () => {
  cleanup();
  await queryClient.cancelQueries();
  resetAppRuntime();
});

describe('terminal audit query policy', () => {
  it('scopes keys by project/run and retries only bounded network or 5xx failures', () => {
    expect(terminalAuditKeys.all('prj-1')).toEqual(['terminal-audits', 'prj-1']);
    expect(terminalAuditKeys.list('prj-1', RUN_ID)).toEqual([
      'terminal-audits',
      'prj-1',
      'run-channel-9',
    ]);
    const unauthorized = new ApiRequestError(401, null);
    const forbidden = new ApiRequestError(403, null);
    const serverError = new ApiRequestError(503, null);
    const conflict = new ApiRequestError(409, null);

    expect(retryTerminalAuditQuery(0, unauthorized)).toBe(false);
    expect(retryTerminalAuditQuery(0, forbidden)).toBe(false);
    expect(retryTerminalAuditQuery(0, conflict)).toBe(false);
    expect(retryTerminalAuditQuery(0, serverError)).toBe(true);
    expect(retryTerminalAuditQuery(0, new Error('Network request failed'))).toBe(true);
    expect(retryTerminalAuditQuery(TERMINAL_AUDIT_QUERY_MAX_RETRIES, serverError)).toBe(false);
  });

  it('polls every two seconds while the terminal is ready or input-paused', () => {
    expect(TERMINAL_AUDIT_POLL_MS).toBe(2_000);
    expect(terminalAuditRefetchInterval('ready')).toBe(2_000);
    expect(terminalAuditRefetchInterval('paused')).toBe(2_000);
    for (const phase of [
      'unavailable',
      'available',
      'creating',
      'connecting',
      'closing',
      'closed',
      'exited',
      'error',
    ] as const) {
      expect(terminalAuditRefetchInterval(phase)).toBe(false);
    }
  });
});

describe('useTerminalAuditQuery', () => {
  it('loads cursor pages and caches audit data without controller, ticket, or output', async () => {
    const auditMarker = 'AUDIT#9';
    const newest = audit('audit-new', auditMarker, '2026-08-25T10:00:00.000Z');
    const older = audit('audit-old', 'mvn -q test', '2026-08-25T09:00:00.000Z');
    const cursors: Array<string | null> = [];
    server.use(
      http.get('/api/v1/projects/:projectId/runs/:runId/terminal-audits', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(
          cursor === null
            ? { items: [newest], nextCursor: 'cursor-2' }
            : { items: [older], nextCursor: null },
        );
      }),
    );
    await authenticateAsAlice();
    const { result, rerender } = renderHook(
      ({ phase }: { phase: JobTerminalPhase }) =>
        useTerminalAuditQuery(ALICE_SEED_PROJECT_ID, RUN_ID, phase),
      { initialProps: { phase: 'ready' as JobTerminalPhase }, wrapper: AppProviders },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(cursors).toEqual([null, 'cursor-2']);

    const key = terminalAuditKeys.list(ALICE_SEED_PROJECT_ID, RUN_ID);
    const cached = queryClient.getQueryCache().find({ queryKey: key });
    expect(cached?.queryKey).toEqual(key);
    expect(cached?.observers[0]?.options.retry).toBe(retryTerminalAuditQuery);
    expect(cached?.observers[0]?.options.refetchInterval).toBe(TERMINAL_AUDIT_POLL_MS);
    expect(JSON.stringify(cached?.state.data)).toContain(auditMarker);
    expect(JSON.stringify(cached?.state.data)).not.toMatch(/PTY#9|RUN#9/);
    expect(JSON.stringify({ key: cached?.queryKey, data: cached?.state.data })).not.toMatch(
      /ticket|controller|rawOutput|terminal bytes|output/i,
    );

    rerender({ phase: 'paused' as const });
    await waitFor(() =>
      expect(cached?.observers[0]?.options.refetchInterval).toBe(TERMINAL_AUDIT_POLL_MS),
    );
    rerender({ phase: 'closing' as const });
    await waitFor(() => expect(cached?.observers[0]?.options.refetchInterval).toBe(false));
  });

  it('marks the project/run audit query stale for a final exit refresh', async () => {
    const isolated = new QueryClient();
    const key = terminalAuditKeys.list('prj-1', RUN_ID);
    isolated.setQueryData(key, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
    expect(isolated.getQueryCache().find({ queryKey: key })?.state.isInvalidated).toBe(false);

    await invalidateTerminalAudits(isolated, 'prj-1', RUN_ID);

    expect(isolated.getQueryCache().find({ queryKey: key })?.state.isInvalidated).toBe(true);
  });
});
