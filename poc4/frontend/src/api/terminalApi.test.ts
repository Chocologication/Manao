import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRunId } from '../contracts/run';
import { parseTerminalSessionId } from '../contracts/terminal';
import { createTerminalSession, listTerminalAudits } from './terminalApi';
import { HttpClient, setHttpClient } from './httpClient';

const PROJECT_ID = 'prj/opaque';
const RUN_ID = parseRunId('run/opaque');

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function setup(fetchImpl: typeof fetch) {
  setHttpClient(new HttpClient({ getAccessToken: () => 'access-token', onUnauthorized: vi.fn(), fetchImpl }));
}

afterEach(() => setHttpClient(null));

describe('terminal API', () => {
  it('POSTs an encoded scoped session request with exact body, Bearer and AbortSignal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ sessionId: 'session/opaque', ticket: 'ticket/opaque', expiresAt: '2099-08-25T10:00:30.000Z' }));
    setup(fetchImpl);
    const abort = new AbortController();
    await expect(createTerminalSession(PROJECT_ID, RUN_ID, { cols: 80, rows: 24 }, abort.signal)).resolves.toEqual({ sessionId: 'session/opaque', ticket: 'ticket/opaque', expiresAt: '2099-08-25T10:00:30.000Z' });
    const [rawUrl, init] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl), 'http://app.local');
    expect(url.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs/run%2Fopaque/terminal-sessions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
    expect(init?.body).toBe(JSON.stringify({ cols: 80, rows: 24 }));
    expect(init?.signal).toBe(abort.signal);
    expect(`${rawUrl}${init?.body}`).not.toMatch(/access-token|command|container|resource/);
  });

  it('GETs fifty terminal audits with encoded opaque cursor and Bearer auth', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ items: [], nextCursor: null }));
    setup(fetchImpl);
    await expect(listTerminalAudits(PROJECT_ID, RUN_ID, 'cursor/opaque+')).resolves.toEqual({ items: [], nextCursor: null });
    const [rawUrl, init] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl), 'http://app.local');
    expect(url.pathname).toBe('/api/v1/projects/prj%2Fopaque/runs/run%2Fopaque/terminal-audits');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe('cursor/opaque+');
    expect(init?.method ?? 'GET').toMatch(/^GET$/i);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
  });

  it('rejects invalid session dimensions before issuing a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    setup(fetchImpl);
    await expect(createTerminalSession(PROJECT_ID, RUN_ID, { cols: 1, rows: 24 })).rejects.toThrow('Invalid terminal response');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(parseTerminalSessionId('session/opaque')).toBe('session/opaque');
  });
});
