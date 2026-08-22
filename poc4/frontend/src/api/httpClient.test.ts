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
