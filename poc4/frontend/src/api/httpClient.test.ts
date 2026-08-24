import { afterEach, describe, expect, it, vi } from 'vitest';
import { login } from './authApi';
import { ApiRequestError } from './ApiRequestError';
import { HttpClient, setHttpClient, type HttpClientOptions } from './httpClient';
import { createProject, getProject, listProjects } from './projectApi';
import type { LoginResponse } from '../contracts/auth';
import type { ProjectListResponse, ProjectSummary } from '../contracts/project';

const loginResponse: LoginResponse = {
  accessToken: 'new-token',
  expiresAt: '2026-08-21T00:15:00.000Z',
  user: { id: 'u1', username: 'alice' },
};

const projectSummary: ProjectSummary = {
  id: 'prj-1',
  name: 'Demo',
  state: 'READY',
  createdAt: '2026-08-21T00:00:00.000Z',
  failureReason: null,
};

const projectList: ProjectListResponse = { items: [projectSummary], limit: 3 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createClient(
  fetchImpl: typeof fetch,
  overrides: Partial<Pick<HttpClientOptions, 'getAccessToken' | 'onUnauthorized'>> = {},
): HttpClient {
  return new HttpClient({
    getAccessToken: () => 'access-token',
    onUnauthorized: vi.fn(),
    fetchImpl,
    ...overrides,
  });
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  throw new Error('expected request to fail');
}

describe('HttpClient', () => {
  it('sends relative /api/v1/ URLs and rejects absolute URLs', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(projectList));
    const client = createClient(fetchImpl);

    await expect(client.request('/api/v1/projects')).resolves.toEqual(projectList);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/projects');

    await expect(client.request('https://example.com/api/v1/projects')).rejects.toThrow(
      'Relative /api/v1/ URL required',
    );
    await expect(client.request('http://127.0.0.1/api/v1/projects')).rejects.toThrow(
      'Relative /api/v1/ URL required',
    );
    await expect(client.request('//evil.example/api/v1/projects')).rejects.toThrow(
      'Relative /api/v1/ URL required',
    );
    await expect(client.request('/api/v2/projects')).rejects.toThrow(
      'Relative /api/v1/ URL required',
    );
    expect(fetchImpl).not.toHaveBeenCalledTimes(2);
  });

  it('sets Authorization Bearer when authenticated', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(projectList));
    const client = createClient(fetchImpl, { getAccessToken: () => 'access-token' });

    await client.request('/api/v1/projects');

    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
  });

  it('omits Authorization for login requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(loginResponse));
    const client = createClient(fetchImpl, { getAccessToken: () => 'stale-token' });

    await client.request('/api/v1/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'secret' },
      auth: false,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe(
      'application/json',
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ username: 'alice', password: 'secret' }),
    );
  });

  it('parses JSON success bodies and returns undefined for 204', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(projectSummary))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createClient(fetchImpl);

    await expect(client.request('/api/v1/projects/prj-1')).resolves.toEqual(projectSummary);
    await expect(client.request('/api/v1/projects/prj-1')).resolves.toBeUndefined();
  });

  it('throws structured ApiRequestError on non-2xx responses', async () => {
    const body = {
      code: 'PROJECT_LIMIT_REACHED' as const,
      message: 'Limit of 3 projects reached',
      traceId: 'trace-409',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 409));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const error = await expectRejection(
      client.request('/api/v1/projects', { method: 'POST', body: { name: 'four' } }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 409,
      body,
      traceId: 'trace-409',
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves structured Stage 5 terminal API error codes', async () => {
    const body = {
      code: 'TERMINAL_SESSION_ALREADY_ACTIVE',
      message: 'Terminal session is already active',
      traceId: 'trace-terminal-active',
    };
    const client = createClient(vi.fn<typeof fetch>(async () => jsonResponse(body, 409)));

    await expect(client.request('/api/v1/projects/prj-1/runs/run-1/terminal-sessions')).rejects.toMatchObject({
      status: 409,
      body,
      traceId: 'trace-terminal-active',
    });
  });

  it('invokes onUnauthorized exactly once per 401 response', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Token expired',
      traceId: 'trace-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const first = await expectRejection(client.request('/api/v1/projects'));
    expect(first).toBeInstanceOf(ApiRequestError);
    expect(first).toMatchObject({ status: 401, body, traceId: 'trace-401' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    await expectRejection(client.request('/api/v1/projects'));
    expect(onUnauthorized).toHaveBeenCalledTimes(2);
  });

  it('does not invoke onUnauthorized for 401 when auth is false', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Invalid username or password',
      traceId: 'trace-login-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const error = await expectRejection(
      client.request('/api/v1/auth/login', {
        method: 'POST',
        body: { username: 'alice', password: 'wrong' },
        auth: false,
      }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
  });

  it('does not invoke onUnauthorized for 401 when no Authorization header is sent', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Authentication required',
      traceId: 'trace-anon-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, {
      getAccessToken: () => null,
      onUnauthorized,
    });

    const error = await expectRejection(client.request('/api/v1/projects'));

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
  });

  it('does not invoke onUnauthorized when a delayed 401 belongs to a previous token', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Token expired',
      traceId: 'trace-stale-401',
    };
    let currentToken = 'alice-token';
    let release: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => delayed);
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, {
      getAccessToken: () => currentToken,
      onUnauthorized,
    });

    const pending = client.request('/api/v1/projects');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer alice-token');
    currentToken = 'bob-token';
    release?.(jsonResponse(body, 401));

    const error = await expectRejection(pending);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body, traceId: 'trace-stale-401' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps generic network errors without claiming a mutation succeeded', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const error = await expectRejection(
      client.request('/api/v1/projects', { method: 'POST', body: { name: 'Demo' } }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiRequestError);
    const message = String((error as Error).message).toLowerCase();
    expect(message).toMatch(/network request failed/);
    expect(message).not.toMatch(/saved|succeeded|created/);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry mutations automatically', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse(projectSummary, 202));
    const client = createClient(fetchImpl);

    await expect(
      client.request('/api/v1/projects', { method: 'POST', body: { name: 'Demo' } }),
    ).rejects.toThrow(/network request failed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends DELETE with a JSON body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ path: 'src/App.java', workspaceRevision: 'rev-2' }),
    );
    const client = createClient(fetchImpl);
    const body = { expectedWorkspaceRevision: 'rev-1' };

    await expect(
      client.request('/api/v1/projects/prj/entries?path=src/App.java', {
        method: 'DELETE',
        body,
      }),
    ).resolves.toEqual({ path: 'src/App.java', workspaceRevision: 'rev-2' });

    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('DELETE');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('passes AbortSignal unchanged to fetch', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(projectList));
    const client = createClient(fetchImpl);

    await client.request('/api/v1/projects', { signal: controller.signal });

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('does not remap AbortError or DOMException abort to a network failure', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const namedAbort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockRejectedValueOnce(abortError).mockRejectedValueOnce(namedAbort);
    const client = createClient(fetchImpl);

    const first = await expectRejection(client.request('/api/v1/projects', { signal: new AbortController().signal }));
    expect(first).toBe(abortError);
    expect(String((first as Error).message).toLowerCase()).not.toMatch(/network request failed/);

    const second = await expectRejection(client.request('/api/v1/projects'));
    expect(second).toBe(namedAbort);
    expect(String((second as Error).message).toLowerCase()).not.toMatch(/network request failed/);
  });

  it('parses Stage 3 409 mutation error codes', async () => {
    const cases = [
      { code: 'PROJECT_LOCKED' as const, message: 'Project is locked' },
      { code: 'WORKSPACE_REVISION_CONFLICT' as const, message: 'Revision conflict' },
      { code: 'ENTRY_ALREADY_EXISTS' as const, message: 'Entry exists' },
      { code: 'ENTRY_NOT_FOUND' as const, message: 'Entry missing' },
      { code: 'DIRECTORY_NOT_EMPTY' as const, message: 'Directory not empty' },
    ];
    for (const item of cases) {
      const body = { code: item.code, message: item.message, traceId: `trace-${item.code}` };
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 409));
      const client = createClient(fetchImpl);
      const error = await expectRejection(
        client.request('/api/v1/projects/prj/entries', {
          method: 'POST',
          body: { kind: 'file', path: 'a.txt', expectedWorkspaceRevision: 'rev-1' },
        }),
      );
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: 409, body, traceId: body.traceId });
    }
  });

  it('parses INVALID_PATH, FILE_TOO_LARGE and BINARY_FILE error codes', async () => {
    const cases = [
      { code: 'INVALID_PATH' as const, status: 400, message: 'Path rejected' },
      { code: 'FILE_TOO_LARGE' as const, status: 413, message: 'File too large' },
      { code: 'BINARY_FILE' as const, status: 415, message: 'Binary file' },
    ];
    for (const item of cases) {
      const body = { code: item.code, message: item.message, traceId: `trace-${item.code}` };
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, item.status));
      const client = createClient(fetchImpl);
      const error = await expectRejection(client.request('/api/v1/projects/prj/files/meta?path=a'));
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: item.status, body, traceId: body.traceId });
    }
  });

  it('parses Stage 4 run error codes', async () => {
    const cases = [
      { code: 'RUN_ALREADY_ACTIVE' as const, status: 409, message: 'A run is already active' },
      { code: 'RUN_STATE_CONFLICT' as const, status: 409, message: 'Run state conflict' },
      { code: 'RUN_NOT_FOUND' as const, status: 404, message: 'Run not found' },
      { code: 'LOG_TICKET_NOT_AVAILABLE' as const, status: 503, message: 'Log ticket not available' },
    ];
    for (const item of cases) {
      const body = { code: item.code, message: item.message, traceId: `trace-${item.code}` };
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, item.status));
      const client = createClient(fetchImpl);
      const error = await expectRejection(
        client.request('/api/v1/projects/prj/runs', {
          method: 'POST',
          body: { expectedWorkspaceRevision: 'rev-1' },
        }),
      );
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toMatchObject({ status: item.status, body, traceId: body.traceId });
    }
  });

  it('does not treat UNSUPPORTED_ENCODING as a server error code', async () => {
    const body = {
      code: 'UNSUPPORTED_ENCODING',
      message: 'Not UTF-8',
      traceId: 'trace-enc',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 415));
    const client = createClient(fetchImpl);

    const error = await expectRejection(client.request('/api/v1/projects/prj/files/content?path=a'));

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 415, body: null });
  });

  it('requestBlob uses relative URLs, Bearer auth, and a byte Accept header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response('payload', {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="App.java"',
          },
        }),
    );
    const client = createClient(fetchImpl);

    const result = await client.requestBlob('/api/v1/projects/prj/files/download?path=App.java', {
      fallbackName: 'fallback.java',
    });

    expect(result.filename).toBe('App.java');
    expect(await result.blob.text()).toBe('payload');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/projects/prj/files/download?path=App.java');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('access-token');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');
    const accept = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Accept');
    expect(accept).not.toBe('application/json');
    expect(accept).toMatch(/octet-stream|\*\/*/);

    await expect(client.requestBlob('https://example.com/api/v1/projects/prj/files/download')).rejects.toThrow(
      'Relative /api/v1/ URL required',
    );
  });

  it('requestBlob prefers a validated Content-Disposition filename and sanitizes fallbacks', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(
        new Response('a', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="src/App.java"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('b', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="App\t.java"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('c', {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=""' },
        }),
      )
      .mockResolvedValueOnce(
        new Response('d', {
          status: 200,
          headers: { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.txt" },
        }),
      )
      .mockResolvedValueOnce(new Response('e', { status: 200 }));
    const client = createClient(fetchImpl);
    const url = '/api/v1/projects/prj/files/download?path=f';

    expect((await client.requestBlob(url, { fallbackName: 'fallback.java' })).filename).toBe(
      'App.java',
    );
    expect((await client.requestBlob(url, { fallbackName: 'fallback.java' })).filename).toBe(
      'App.java',
    );
    expect((await client.requestBlob(url, { fallbackName: 'dir/out.bin' })).filename).toBe('out.bin');
    expect((await client.requestBlob(url, { fallbackName: 'fallback.java' })).filename).toBe(
      '测试.txt',
    );
    expect((await client.requestBlob(url, { fallbackName: '\n\t' })).filename).toBe('download');
  });

  it('requestBlob invokes onUnauthorized for a current-token 401', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Token expired',
      traceId: 'trace-blob-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const error = await expectRejection(
      client.requestBlob('/api/v1/projects/prj/files/download?path=a', { fallbackName: 'a.bin' }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body, traceId: 'trace-blob-401' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('requestBlob does not invoke onUnauthorized for 401 when auth is false', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Invalid username or password',
      traceId: 'trace-blob-login-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, { onUnauthorized });

    const error = await expectRejection(
      client.requestBlob('/api/v1/projects/prj/files/download?path=a', {
        fallbackName: 'a.bin',
        auth: false,
      }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
  });

  it('requestBlob does not invoke onUnauthorized for 401 when no Authorization header is sent', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Authentication required',
      traceId: 'trace-blob-anon-401',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body, 401));
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, {
      getAccessToken: () => null,
      onUnauthorized,
    });

    const error = await expectRejection(
      client.requestBlob('/api/v1/projects/prj/files/download?path=a', { fallbackName: 'a.bin' }),
    );

    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
  });

  it('requestBlob does not invoke onUnauthorized when a delayed 401 belongs to a previous token', async () => {
    const body = {
      code: 'UNAUTHENTICATED' as const,
      message: 'Token expired',
      traceId: 'trace-blob-stale-401',
    };
    let currentToken = 'alice-token';
    let release: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => delayed);
    const onUnauthorized = vi.fn();
    const client = createClient(fetchImpl, {
      getAccessToken: () => currentToken,
      onUnauthorized,
    });

    const pending = client.requestBlob('/api/v1/projects/prj/files/download?path=a', {
      fallbackName: 'a.bin',
    });
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer alice-token');
    currentToken = 'bob-token';
    release?.(jsonResponse(body, 401));

    const error = await expectRejection(pending);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, body, traceId: 'trace-blob-stale-401' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('auth and project APIs', () => {
  afterEach(() => {
    setHttpClient(null);
  });

  it('login posts credentials without an Authorization header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(loginResponse));
    setHttpClient(
      new HttpClient({
        getAccessToken: () => 'stale-token',
        onUnauthorized: vi.fn(),
        fetchImpl,
      }),
    );

    await expect(login({ username: 'alice', password: 'secret' })).resolves.toEqual(loginResponse);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBeNull();
  });

  it('lists, creates, and gets projects through relative API routes', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(projectList))
      .mockResolvedValueOnce(jsonResponse({ ...projectSummary, state: 'CREATING' }, 202))
      .mockResolvedValueOnce(jsonResponse(projectSummary));
    setHttpClient(
      new HttpClient({
        getAccessToken: () => 'access-token',
        onUnauthorized: vi.fn(),
        fetchImpl,
      }),
    );

    await expect(listProjects()).resolves.toEqual(projectList);
    await expect(createProject({ name: 'Demo' })).resolves.toEqual({
      ...projectSummary,
      state: 'CREATING',
    });
    await expect(getProject('prj/a b')).resolves.toEqual(projectSummary);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/v1/projects');
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i);
    expect(authorizationHeader(fetchImpl.mock.calls[0]?.[1])).toBe('Bearer access-token');

    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/v1/projects');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('POST');
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ name: 'Demo' }));

    expect(fetchImpl.mock.calls[2]?.[0]).toBe(`/api/v1/projects/${encodeURIComponent('prj/a b')}`);
  });
});
